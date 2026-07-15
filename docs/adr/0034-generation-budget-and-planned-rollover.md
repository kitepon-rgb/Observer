# ADR 0034: generation budgetとplanned rolloverをexact reservationで固定する

日付: 2026-07-15

## Status

Accepted for implementation。state machine、host配線、実provider検証は未実装。

## Context

[ADR 0025](0025-parent-session-observer-generation.md)は、一つのparent session epochへ一つの論理Observerを
束縛し、context budget到達時だけ物理host generationを世代交代すると裁定した。P4-2では一cycleの
evidence snapshotを最大32 KiBへ固定したため、generationのhard thresholdを実装できる。

cycle完了後の単純加算では、上限直前に開始したcycleが256 KiBを超え得る。またcursor commitと別transactionで
generationを加算すると、crash recoveryで未計上または二重計上になる。watch stateへcounterを混ぜると、利用者の
監視認可と物理model sessionの寿命も結合してしまう。

## Decision

1. 一parent session epochに一つの論理Observer、一watch内で同時にactiveな物理generationは一つとする。
   watchは利用者の監視認可、generationはmodel sessionであり、別schema／別stateとして所有する。
2. `parent_epoch_id`はproviderとThroughlineの`thread_sha256`をdomain separationして生成し、raw thread IDを
   generation stateへ保存しない。generation IDはwatch ID、parent epoch ID、単調なsequenceから決定的に生成する。
3. 一generationのhard ceilingは、最大8 completed cycleかつObserver所有model-visible payload累積
   262,144 UTF-8 bytes以下とする。provider内部prompt、非公開token推定、raw tool logはmeterへ含めない。
   Observerが確定した完全なmodel requestのうち、静的指示、bounded carryover、evidence snapshot、出力契約を含む
   model可視部分をcanonical serialization後のexact UTF-8 bytesで数える。
4. model呼出し前に`cycle_id`、input digest、exact byte数をgenerationへ予約する。completed cycleが8以上、または
   `累積bytes + 次input bytes > 262,144`なら旧generationではmodelを呼ばず`planned_rollover`を返す。
   fresh generationでも一入力が上限を超える場合は無限rolloverせず`E_GENERATION_INPUT_TOO_LARGE`でfail closedにする。
5. 同じcycleの同一digest／bytes予約は冪等とし、異なる予約は拒否する。一つのgenerationでpending reservationは
   一件だけとする。reservationの確定加算はcycle resultとcursor commitのtransactionへ接続し、cycle IDを
   exact-once keyとしてcrash後の再実行でも二重加算しない。未完cycleはcompleted countへ加えない。
6. planned rolloverは`active -> rollover_requested -> stopping -> terminal_confirmed -> starting -> active`の
   明示transitionとreceiptで表す。旧generationのterminal receiptを確認するまでsequenceを進めず、新世代を
   起動しない。stop command ACK、timeout、handle不明をterminal成功へ丸めない。
7. parent rebind、planned rollover、fault recoveryは別reason／別transitionとする。parent rebindは同じwatchの
   認可を維持しつつ論理Observerのepochを切り替えるが、旧generation terminal不明時は並走せずwatchをfaultedにする。
8. 世代間で渡せるのは、committed cursor、digest-onlyなdedupe／cooldown receipt、上限付き未解決仮説、相関IDだけとする。
   raw会話、model入出力全文、prompt全文、tool logは保存しない。P4-3以前は未実装carryoverを空として扱う。
9. state実装とbudget reservationを先に独立Taskで完成させる。Supervisor／cycle transaction接続、Claude／Codexの
   terminal stopと次generation start、実provider検証は後続の独立gateとし、接続前にlive modelを起動しない。

初期state実装は`observer.generation_state.v1`として、次のexact fieldを持つ。

- identity: `schema`、`watch_id`、`target_id`、`provider`、`parent_epoch_id`、`generation_id`、`sequence`
- lifecycle: `status`、`rollover_reason`、`host_handle_digest`、`activation_receipt_digest`、
  `terminal_receipt_digest`、`previous_terminal_receipt_digest`
- budget: `completed_cycles`、`model_visible_bytes`、`pending_reservation`、`last_completed_cycle`
- time: `created_at`、`updated_at`

`pending_reservation`は`cycle_id / input_digest / model_visible_bytes`、`last_completed_cycle`はそれらに
`result_digest`を加えたbounded objectとする。初期公開APIは次に固定する。

- `initializeGeneration`: active watchとvalidated ready host receipt本体のprovider／watch／target／handleを照合し、
  sequence 1をactiveで作る。stateにはreceiptとhandleのcanonical digestだけを保存する。
- `readGenerationState`: exact schemaを検証して返し、不正stateを欠損へ丸めない。
- `reserveGenerationInput`: 同一予約を冪等化し、予算内なら一件だけ保存、予算不足なら
  `rollover_requested`へ遷移してmodel呼出しを拒否する。
- `completeGenerationCycle`: 同一completed cycleを冪等化し、counterとlast completed receiptを更新する。
- `requestGenerationStop`: rollover requestedをstoppingへ進めるrecord-only操作とし、host commandを送らない。
- `confirmGenerationTerminal`: validated terminal receipt本体を要求し、保存済みhandle digestとの一致後だけ
  terminal confirmedへ閉じる。stateにはcanonical receipt digestだけを保存する。
- `beginNextGeneration`: terminal confirmedだけからsequenceを一つ進め、startingを作る。hostをspawnしない。
- `activateGeneration`: 同じstarting generationとidentityが一致するvalidated ready host receipt本体だけでactiveへ進める。

すべてのmutationはtargetの既存transaction lockを使い、watch ID／provider／statusを再照合する。generation APIは
host command、model request、Mailbox publishを実行しないrecord-only境界とする。

## Rejected alternatives

- watchごとに一つの物理sessionを永続化する案: context成長をboundedにできない。
- cycleごとにsessionを捨てる案: provider消費、起動cost、アプリ上のthread数が増え、伴走者としての連続性を失う。
- 経過時間だけで交代する案: 実際のmodel-visible量と対応せず、長いcycleの上限超過を防げない。
- cycle完了後だけthresholdを確認する案: 上限直前の次入力でhard ceilingを越える。
- 自由文要約を次世代へ渡す案: 検証不能な第二の可変正本とcontext再膨張を作る。
- 複数Observerを同じparentへ並走させる案: 重複指摘、cooldown競合、通知順序の不定性を増やす。

## Consequences

- 利用者には同じ論理Observerが伴走し続け、内部の物理contextだけをboundedに交換できる。
- exact byte計測とreservationがmodel呼出しの必須gateになり、adapterは計測receiptを返す必要がある。
- generation stateはcycle storeと同じtarget transaction lockを共有するが、watch認可schemaは変更しない。
- host rolloutが未接続の間、threshold到達は新世代を暗黙起動せず明示的な未完状態として止まる。
