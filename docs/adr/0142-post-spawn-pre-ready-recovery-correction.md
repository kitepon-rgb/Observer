# ADR 0142: post-spawn／pre-ready recoveryを訂正する

日付: 2026-07-16

## Status

Accepted design。P5-1b5b-r16の実装と受入れは未完了。

## Context

独立監査の中断前に報告された候補を親が実コードで再確認し、次を採用した。

- `requestParentLaunchFailureCleanup`はparent launch coreとtestに存在するが、製品callerから呼ばれていない。
- Codex callerはactivation成功後にだけterminal shutdownを装着する。activation内部ではspawn handleを
  `launching`へ耐久化した後にbootstrap terminalを待つため、failed／interrupted／timeoutではraw transport
  closeだけが走り、watch cleanupへ接続されない。
- Claude callerはspawn後にsession shutdownを有効化するが、ready前のactivation失敗ではsession／MCPを
  閉じるだけで、同じwatchを`faulted`へ進めない。
- watch storeは`launching`をLIVEとして扱うため、残ったwatchは次回の正規予約を拒否し続ける。

provider資源のcloseとwatch recoveryは別契約であり、片方だけを成功させてもlaunch failure cleanupにはならない。

## Decision

1. callerはvalidated spawned receiptを得た時点からready確定まで、同じlaunch requestとreceiptだけを
   pre-ready cleanup identityとして所有する。
2. ready前に失敗したら、`requestParentLaunchFailureCleanup`へ同じrequest／receiptと固定fault code
   `E_OBSERVER_LAUNCH_CONFIRM_FAILED`を渡し、保存済みhandleとのCASでwatchを`stopping`へ進める。
3. Codexは同じthread／turn journalとsessionでbounded stopを行う。bootstrap failed／interruptedはterminalを
   exact観測し、timeoutは同じturnだけをinterruptしてterminalを待つ。別turnを開始しない。
4. Claudeは同じsession handleとAiterm transportで`pty_close`し、terminal receiptを得る。
5. provider terminal receipt後だけ`completeParentStop`で同じwatchを`faulted`へ確定し、その後にtransportを閉じる。
6. cleanup失敗は元のready失敗とともに`AggregateError`でfail loudにする。別watch、別provider、handle推測、
   暗黙restart、pre-spawn fault APIへのfallbackを行わない。
7. handle取得前の失敗、ready後の通常停止、Codex protocol、Observer cycle、Supervisorの非AI責務は変更しない。

## Acceptance

- Codex bootstrap failed／interrupted／timeoutの各fixtureで、同じspawn receiptによる
  cleanup request、provider terminal、watch `faulted`、raw transport closeの順序を固定する。
- Claude ready前失敗で、同じsessionの`pty_close`、watch `faulted`、MCP closeの順序を固定する。
- cleanup identity不一致、provider terminal不明、watch transition失敗は元エラーへ隠さずfail loudにする。
- cleanup後は同じtargetの次回予約が可能で、別watch／別provider／handle推測を一度も使わないことを確認する。
- intentional live fault、model request、network、credentialは使わない。

## Rollback

実装commitをrevertし、P5-1b5b-r16を未完了へ戻す。provider closeだけでwatch recoveryを完了扱いにせず、
`launching`残留を明示欠陥として維持する。
