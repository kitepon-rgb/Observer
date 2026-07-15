# ADR 0003: Throughline公開CLIと一監視cycleのtransaction境界

日付: 2026-07-15

## Context

ObserverはThroughlineのDB、WAL、rolloutを直接読まず、公開`observer-read`／`observer-wait` CLIだけを
子processとして使う。waitが`changed`を返した後のreadはpaginationまたは`projection_pending`になりうる。
途中page、CLI failure、cancel、schema不正で保存cursorを進めると、確定turnを欠落させる。

## Decision

1. ObserverのThroughline clientはshellを介さず、引数配列で`throughline observer-read`と
   `throughline observer-wait`を起動する。実行binaryはtest用に明示注入できるが、DB直読へfallbackしない。
2. 成功はexit 0、単一のbounded JSON stdout、期待schemaの全てが成立した時だけとする。non-zero exit、
   signal終了、複数JSON、過大stdout／stderr、不正schemaは固定Observer errorとして表面化し、
   upstream stderr本文を利用者向けmessageへ転載しない。
3. callerのAbortSignalは子processへ伝播し、cancelをtimeoutや成功へ変換しない。listener、timer、process
   handleを終了時に必ず解放する。
4. 初回orientationはcomplete snapshotだけを受理する。`projection_pending`ではparent stateを作らない。
5. 一監視cycleは保存cursorから最大3600秒waitする。`timeout`はcursor不変の正常結果、`changed`は
   waitが返したfixed `throughCursor`を上限にreadする。`resync_required`と`ambiguous_parent`はfaultとする。
6. `changed` readは同じ`afterCursor`／`throughCursor`へ束縛したpage tokenで全pageを回収する。
   `projection_pending`、途中page、hard failureでは保存stateを不変に保つ。
7. 全pageのschema、cursor連結、parent identityが成立した時も、cycleは`proposed_state`とbounded turnsを
   Supervisorへ返すだけにする。監査とObserver stateのatomic commitが成功する前にcursorを保存しない。
8. Throughline clientとcycle coreはprovider-neutralとし、Claude／Codex launcher、Stop continuation、
   active watch、AI監査、MailboxをこのTaskへ含めない。

## Public module boundary

- `src/throughline-client.mjs`: read／wait subprocess、bounded JSON、cancel、wire検証。
- `src/watch-cycle.mjs`: orientation、timeout、fixed-through pagination、`proposed_state`生成。
- `test/throughline-client.test.mjs`、`test/watch-cycle.test.mjs`: fake executable／injected clientによるcontract test。

## Consequences

- subprocessとcursor transactionを独立testでき、provider launcherへhost固有wireを漏らさない。
- `changed`を受けただけではcursorを消費せず、crash後も旧cursorから再取得できる。
- `projection_pending`のbounded retry policyと永続state commitはSupervisor Taskで追加する。
