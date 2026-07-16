# ADR 0140: Codex app-server process group cleanupを訂正する

日付: 2026-07-16

## Status

Accepted design。P5-1b5b-r15の実装と受入れは未完了。

## Context

queue 19eのCodex r10／r11ではapp-server leaderのterminalとlocal app-server件数0を確認し、
ADR 0139でprocess残留0とした。しかしcampaign root削除前のopen file検査で、両attemptが起動した
MCP process群16件が同rootを`cwd`にしたまま残留していた。

Observerはapp-serverを`detached: true`で固有process groupへ隔離した一方、終了時は
`child.kill(signal)`でleader PIDだけへsignalを送っていた。leaderの`close`は子孫processの終了証拠ではない。
既存孤児はcampaign所有PIDへの通常SIGTERMで16/16終了し、campaign rootは削除した。

## Decision

1. macOS production routeでは、detached app-serverのPIDを固有process group IDとして所有する。
2. transport abort、通常close、grace超過後のSIGKILLはleader PIDでなく固有process group全体へ送る。
3. `closeAndWait`はleaderの`close`とprocess group不在の両方をboundedに確認して初めて`closed`を返す。
4. leaderが先に終了してもgroupが残る間は成功にしない。grace超過時は同じgroupへSIGKILLし、それでも
   group消滅を確認できなければ`E_CODEX_PROCESS_TERMINATION_UNKNOWN`でfail loudにする。
5. process group ID欠損、signal／probeの予期しない失敗をleader-only cleanupへfallbackしない。
6. Codex protocol、thread／turn、Observer cycle、Supervisorの非AI責務は変更しない。

## Acceptance

- focused testでSIGTERM／SIGKILLの対象が負の固有PGIDであることを固定する。
- leader close後もgroup aliveなら成功せず、group消滅後だけterminal receiptを返す。
- groupが消えない場合とsignal／probe失敗をfail loudにする。
- 実OS subprocess fixtureでleaderが子processを残して終了するcaseを作り、cleanup後にgroup／子PIDが
  残らないことを確認する。model request、credential、networkは使わない。
- Codex caller／Supervisor関連gateを一度通す。full regressionはP5-3で既に一度実施したため、
  r15修理後のPhase closureで必要性を再裁定し、細かな反復はしない。

## Correction

ADR 0139のClaude／Codex cycle、65秒超、pending state、config rollback証拠は維持する。ただしCodexの
`local process残留0`はapp-server leaderだけを数えたため棄却し、本ADRのgroup cleanup受入れまで
P5-1b5／queue 19eを完了扱いにしない。

## Rollback

実装commitをrevertし、P5-1b5を未完了へ戻す。leader-only terminalをprocess全体の成功へ読み替えず、
campaign cleanupでは所有PIDを列挙して通常signalで明示回収する。
