# ADR 0018: Codex app-serverのthread handleとturn operationを分離する

日付: 2026-07-15

## Status

Accepted for core implementation。app-server process transport、実model turn、CodexアプリUI、65秒超wait、
adapter crash後のunknown reconciliation、Observer MCP限定writeは未検証であり、production host採用はしない。

## Context

Codex native subagentはunrestricted親のsandbox overrideを継承し、Observerのread-only境界を強制できない。
app-serverのpersistent threadはper-thread read-onlyと別processからのread/list回収を部分実証済みだが、
thread、turn、connectionの耐久境界が未定義だった。

Observerの全watchは同じcanonical Observer rootを`cwd`にする。そのため`thread/start`結果不明時に
`thread/list(cwd=Observer)`が一件だけ返っても、旧threadまたは別targetのwatchであり得る。watch IDへ束縛された
公式filterがない以上、cwd singletonを同一watchへ自動attachできない。またturn IDは`turn/start` responseで
初めて得られるため、response不明時に同じlogical operationを安全に再実行できない。

## Decision

1. Codex parent launch requestを`codex.app_server_thread.v1`へ変更する。`thread/start`と`thread/resume`は
   canonical Observer root、`approvalPolicy=never`、`sandbox=read-only`、persistent threadを要求し、
   responseのOpenAI provider、cwd、read-only policy、Observer `AGENTS.md` instruction sourceを照合する。
2. persistent thread IDをwatchのprivate `codex.thread` handleとする。app-server process／connectionは
   connectionごとに`initialize response → initialized`を行う再作成可能transportであり、durable handleにしない。
3. `thread/start`前にObserver private stateへjournalを作る。結果不明では`thread_start_unknown`へ進め、
   `thread/list`のcwd、件数、preview、serviceNameから自動attachせず、同じwatchの再spawnを拒否する。
4. thread handleを`starting → launching`として親stateへatomic保存した後だけ`turn/start`する。各turnで
   Observer root、`approvalPolicy=never`、`sandboxPolicy=readOnly/networkAccess=false`を再指定し、可変入力は
   exactな`observer.child_start.v1` envelopeだけとする。
5. active operationは`thread_id / turn_id / watch_id / cycle_id / status`をObserver private journalへ保存する。
   turn ID受領前の結果不明は`turn_start_unknown`として止め、同cycleを再実行しない。受領済みturn IDはthread handleへ潰さない。
6. `thread/read(includeTurns=true)`は保存済みIDのterminal reconciliationだけに使い、read成功をreadyへ丸めない。
   再接続後の継続とevent購読は、connection handshake後にObserver cwd/read-onlyを再assertした`thread/resume`だけで行う。
7. `turn/interrupt`の空responseはcommand ACKであり、watchを閉じない。同じthread ID／turn IDの
   `completed | interrupted | failed`をCodex固有terminal receiptへ束縛し、parent launch coreがexact検証した後だけ
   `stopping → stopped | faulted`を許す。interrupt送信前に`stopping`を耐久化し、response不明時も再送せず
   同じturnのterminal再観測だけを許す。thread archive／deleteは停止契約に含めない。
8. production採用には、実process transport、UI、65秒超wait、crash後resume／unknown reconciliation、
   Observer MCP限定write、project write拒否のlive H gateを別途要求する。fake transportのgreenをexecution-verifiedへ読み替えない。

## Verification

- `test/codex-host-adapter.test.mjs`: cwd／policy／instruction source、threadとturnの分離、read／resume、interrupt ACKを固定する。
- `test/codex-host-runtime.test.mjs`: handshake順、handle先行耐久化、thread／turn unknown再実行拒否、journal、terminal相関を固定する。
- `test/parent-launch.test.mjs`: `codex.thread` handleと同一thread／turn terminal receiptを必須化する。
- focused gate 21/21 PASS。
- `npm run check`を静的gateとして通す。

## Consequences

- target数が増えてもObserver以外のprojectを作らず、同じcwdの別watchを誤って共有しない。
- crash recoveryに必要なthread／turn相関をObserver所有stateへ置き、Codex stateやThroughlineへ責務を移さない。
- unknown resultは自動復旧より安全側へ止まる。公式のwatch-bound idempotency／検索fieldが実証されるまで、
  operator reconciliationなしにattachしない。
- production未採用のため、利用者の明示指示を受けてもこのcoreだけでlive Observerを起動しない。

## Friction check

manual normalization、reconstructed evidence、alternate recoveryは使用していない。Codex model turn、thread作成、
interrupt、session削除、UI操作は実行していない。
