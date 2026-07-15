# ADR 0006: 親所有のprovider launcherを二相transactionにする

日付: 2026-07-15

## Context

ADR 0002は、利用者の明示指示を受けた現在親だけが同providerのObserverを起動すると定めた。
Claude Codeにはbackground sessionの公開CLIがある一方、Codexで同じアプリに表示される子は親threadが
native subagent toolで起動する。ObserverのNode processがCodex native childをshellから偽装したり、
provider差を一つのsubprocess launcherへ丸めると、親所有と同一アプリUXの契約を破る。

また、provider childを先に起動してからactive watchを確保すると二重起動の窓が生じる。逆に予約だけを
active扱いすると、起動失敗後に存在しないchildを監視中と報告する。起動と停止にはhost操作を挟む
二相transactionが必要である。

## Decision

1. Observer coreはhost processを直接共通化せず、`prepare → host action → confirm`の二相契約を所有する。
   prepareは利用者の明示指示を表すexact authorizationが無ければ、target登録を含むstate変更前に拒否する。
   authorizationは親の意味判断を暗号学的に証明するものではなく、暗黙入口からの誤起動をfail closedにする
   呼出契約である。
2. prepareはcanonical project targetを登録し、provider childより先にwatchを`starting`で予約する。
   成功時だけ、raw親session／thread IDやsecretを含まないexact launch requestを返す。
3. Codex requestは`agent_type=observer`、`fork_turns=none`、target由来のbounded task name、固定start messageを持つ。
   現在親がnative spawn、Observer roleのrouting確認、start follow-upを行い、その受理後にcanonical agent pathを
   `codex.agent` handleとしてconfirmする。Observer coreやshell subprocessからnative spawnへfallbackしない。
4. Claude requestは`agent=observer`、target由来のbounded name、Observer runtime root、固定start messageを持つ。
   現在親がClaude Codeのbackground入口で起動し、返されたjob IDを`agents --json --cwd`で同じcwd／nameの
   sessionへ相関してから`claude.job` handleとしてconfirmする。`--print`との併用やheadless sessionへの
   暗黙fallbackを行わない。
5. confirmはrequestのprovider、watch ID、target IDとprovider固有handle kindが全て一致した時だけ
   `starting → active`へ遷移する。launch handleはprivate stateだけへ保存し、公開statusへ出さない。
6. spawn、routing、dispatch、Claude job相関、confirmのいずれかが失敗した時は、起動済みchildがあれば親が
   host正式入口で停止を試み、watchを固定codeで`faulted`へ閉じる。raw stderr、prompt、job logをstateへ保存しない。
   停止確認が不明なら成功扱いせず、その事実を親が利用者へ報告する。
7. 停止も利用者の明示指示を要求する。coreは`active → stopping`とprivate handleを親へ返し、親が
   Codex native interruptまたは`claude stop <job-id>`を実行する。同じhandleの停止確認receiptを再照合した後だけ
   `stopping → stopped`へ遷移する。停止失敗／不明では`stopping`を保持する。
8. terminal watchからの再起動は、親が観測したprevious watch IDと新しい利用者指示による新規prepareを要求する。
   SessionStart、install、project open、Stop hook、fault、provider job終了を契機に自動spawn、takeover、respawnしない。
9. provider agent role、read-only tool profile、Stop continuationの配布はdotagents／installer側のadapterが所有する。
   Observer repoはlaunch transactionとexact wireを所有し、host設定の存在を実装済みに見せない。

## Consequences

- 一target一watchの予約と実child handleが相関し、起動失敗をactiveへ丸めない。
- Codexはnative subagent、Claudeはbackground sessionという各hostの正式UXを維持できる。
- 親AIが行うhost actionをNode libraryだけで完結したようには見せられない。親向けskill／commandとrole配布が
  Dotagents統合の必須成果物になる。
- live spawn／stop、credential、hook設定はH gateを維持し、fixtureだけでexecution-verifiedを主張しない。
