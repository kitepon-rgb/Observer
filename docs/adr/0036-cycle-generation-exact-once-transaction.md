# ADR 0036: cycle commitとgeneration budgetをexact-once transactionへ接続する

日付: 2026-07-15

## Status

Accepted for implementation。host rollover、model operation journal、live provider検証は未実装。

## Context

[ADR 0034](0034-generation-budget-and-planned-rollover.md)と
[ADR 0035](0035-generation-state-store-acceptance.md)により、generation stateはmodel inputを事前予約し、
completed cycleと累積bytesを冪等に加算できる。一方、現在のSupervisor callbackは入力構築とmodel実行を
一つの`processCycle`へまとめ、cycle journalはresult digestしか保存しない。このままではSupervisorが
model呼出し前の予約順序を保証できず、crash後のprocessed recoveryでgeneration completionを再構成できない。

## Decision

1. Supervisor callbackを`prepareCycleInput`と`processCycle`へ分ける。`prepareCycleInput`はmodel-visible入力を
   構築するだけで、model、network、Mailboxを呼ばない。戻り値は
   `observer.cycle_input.v1`のexact objectとし、`input_digest`、`model_visible_bytes`、非永続の`value`を持つ。
2. Supervisorはprepared cycle作成後にinputを検証し、generation storeの`reserveGenerationInput`を呼ぶ。
   新規`reserved`の時だけ`processCycle`へ`value`と検証済みinput receiptを渡す。`planned_rollover`ならmodel callbackを
   呼ばず、pending cycleを`prepared`のまま残して`rollover_required`を返す。
3. `processCycle`がreservationなしに完了する経路を作らない。予約と異なるdigest／bytes、複数の異なるinput、
   fresh generation上限超過はfail closedにする。
4. pending cycle schemaを`observer.pending_cycle.v2`へ上げ、`input_digest`と`model_visible_bytes`をexact fieldに加える。
   `prepared`では両方と`result_digest`をnull、`processed`では三つすべてを必須にする。旧v1 pendingはP4未配線で
   production stateがないため暗黙migrationせず、検出時はunsupported schemaとして止める。
5. `markCycleProcessed`は同じtarget transaction lock内でgeneration stateのpending reservationと
   cycle／input digest／bytesを照合した後だけv2 processed receiptを保存する。
6. generation storeは、検証済みstateとcompletionから次stateを作る副作用なしのpure transitionを公開する。
   persistent wrapperとcycle storeは同じpure transitionを使い、completion規則を二重実装しない。
7. `commitProcessedCycle`はlock取得後、pending、cursor、generation stateをすべて検証して次stateを先に計算する。
   その後cursor、generation、pending cleanupの順にdurable writeする。各write間のcrashではprocessed pendingを残し、
   再実行時にcursorのCASとgenerationのlast completed cycleを照合して不足分だけ適用する。
8. generation state欠損、reservation不一致、cursor不一致は最初のwriteより前に拒否する。cursorだけ進めて
   generation不明を成功扱いせず、generationだけ加算してpendingを消すfallbackも作らない。
9. `result_digest`の既存cycle wireはbare SHA-256 hexを維持する。generation receiptへ渡す時だけ
   `sha256:<hex>`へcanonical変換し、同じresultを別digestとして扱わない。
10. crash後にmodel request自体を再送してよいかは別のmodel operation journal Taskで解決する。本Taskは
    model呼出し前のbudget gateと、既知resultのcursor／budget exact-once commitまでを所有する。
11. `reserveGenerationInput`は同一予約について`created`と`existing`を区別するreceiptを返す。Supervisorが
    recovered prepared cycleで`existing`を観測した時はmodel callbackを再実行せず`model_result_unknown`を返す。
    「model前に落ちたはず」という推測で予約を消したり再送したりしない。

## Crash matrix

- reservation後・model前: 既存reservationを検出し、model operation journalなしには再送しない。
- model結果後・processed保存前: 同じく`model_result_unknown`で止め、再送判断はmodel operation journalへ委ねる。
- processed保存後・cursor前: callbackを再実行せず、journalからcursor／generation commitを再開する。
- cursor後・generation前: cursor CASで既適用を認識し、同じcompletionだけをgenerationへ適用する。
- generation後・pending削除前: last completed cycleで二重加算を防ぎ、pendingだけを削除する。

## Consequences

- 8 cycle／256 KiB gateが実際のmodel呼出し順序へ入り、単なる未接続stateではなくなる。
- pending v2だけでprocessed recovery時のgeneration completionを再構成できる。
- inputの`value`はprocess memoryにだけ存在し、cycle journalへprompt全文を保存しない。
- host rolloverとmodel operation journalが完了するまで、`rollover_required`およびresult不明は暗黙再送せず上位へ返す。
