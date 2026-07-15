# ADR 0002: Observerはユーザーの明示指示を受けた親が同providerで起動する

日付: 2026-07-15

## Context

Observer v1は親と同じproviderで継続監視するが、誰が起動と停止を所有するかが未確定だった。
install、SessionStart、project検出を契機に自動起動すると、利用者が意図しない監視、model利用、
長時間waitが発生する。Observer自身がproviderを推測すると、親と同じアプリで伴走する契約も弱くなる。

## Decision

1. Observerの起動は、利用者が現在の親へ明示的に依頼した時だけ行う。install、SessionStart、
   project open、Throughline更新を契機に暗黙起動しない。
2. 明示指示を受けた親をlauncherとする。Codex親はCodex Observer、Claude親はClaude Observerを、
   各hostの正式なbackground／child入口から起動する。providerを残レートや推測で変更しない。
3. launcherはprovider childを起動する前に、Observer所有stateへproject target単位のactive watchを
   transactionとして確保する。一targetで同時にactiveなwatchは一つだけとする。
4. active watchが既にある時は`already_active`としてfail closedにし、後勝ちtakeover、二重起動、
   既存watchの暗黙停止を行わない。回復はObserver自身が記録した終了／fault証拠か明示停止だけに基づき、
   mtime、親PID、推測TTLからlockを奪わない。
5. 起動後のObserverはADR 0001のcompleted cursorで親thread／hostの切替へ追従する。親threadが
   再作成されても自動で別Observerを増やさない。
6. 利用者が親へ明示的に停止を依頼した時は、親がprovider childを停止し、active watchを閉じる。
   Observerがfaultedになった時はfaultを記録して継続と自動再起動を止め、親へ原因を報告する。
7. 起動／停止の結果は親が利用者へ報告する。Observerの通常の沈黙は起動失敗を意味しない。

## Consequences

- 利用者が監視とmodel利用の開始を明示的に支配できる。
- 親hostが確定しているため、同provider配置を推測なしで決められる。
- provider別launcher、active watch transaction、停止／fault回収がv1の実装対象になる。
- 常駐daemon、login item、install時自動起動、project open時自動起動はv1へ追加しない。
