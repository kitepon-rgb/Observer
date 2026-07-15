# ADR 0015: Claude host実行層をhandle先行耐久化へ束縛する

日付: 2026-07-15

## Status

Accepted for implementation and read-only diagnostics。live Observer spawnはP2-5完了と利用者の明示指示まで禁止する。

## Context

Claude host adapterの純粋core、Observer MCP stdio server、parent-launchの`starting → launching → active`は実装済みだが、
実行fileの真正性確認とCLI process wireは未実装である。初期案の`spawn → agents一覧 → spawned receipt`では、spawn成功後に
親が落ちるとhandleなしの`starting`と孤児jobが残り、ADR 0007の故障を再導入する。

公式Agent view資料は、`claude --bg --name <name>`が
`backgrounded · <short-id> · <name>`を出し、その前に任意のsupervisor起動行が増え得ることを明記する。
このshort IDは`agents`／`attach`／`logs`／`stop`の公開handleである。

## Decision

1. Claude job nameはtarget suffixとwatch UUID suffixを含む一watch固有値にする。
2. `spawn`はfixed cwd／bounded envで`claude --bg`を実行し、stdoutから識別行をexact一件だけ抽出する。
   short IDの`spawned` host receiptを返したら処理を止め、親が`confirmParentHostSpawn`でhandleを耐久化する前にobserveしない。
3. `observe`は保存済みjob ID、固有name、canonical cwdを`claude agents --json --all --cwd`で相関する。
   visibilityはbounded回数だけ待ち、未確認なら`launching`を維持する。別IDへのfallback、fault化、再spawnをしない。
4. spawn timeout／識別行欠落で作成有無が不明なら、固有name＋cwdの回収入口を使う。一件ならそのIDを耐久化し、
   0件はunknown、複数件はcorrelation failureとする。回収中に同じwatchを再spawnしない。
5. `stop`は同jobのterminal観測を先に行う。非terminal時のstop command receiptと、その後のterminal観測を分け、
   command成功だけでparent watchをstoppedへ進めない。`done`もObserver結果回収済みとは扱わない。
6. Claude CLIは親が解決した絶対path、Observer MCPはcanonical runtime rootの`package.json#bin.observer-mcp`から導く固定pathだけを候補にする。
   realpath後のregular executable、owner、mode、ancestor、file identity、content digestを確認し、Claude `2.1.210 (Claude Code)`と
   package／server versionのexact一致を要求する。version更新はunsupportedとしてfail closedにし、互換確認後にallowlistを更新する。
7. Observer MCPはinitializeと`tools/list`を実executableへ行い、exact `{observer_read, observer_wait}`だけを受理する。
   Claudeへ公開・無人許可するtoolも`mcp__observer__observer_read`と`mcp__observer__observer_wait`だけに固定する。
8. verification後と各exec直前にrealpathとfile identityを再照合する。同じeffective UIDとroot／管理者による変更はv1の信頼境界内とし、
   同一ユーザーに対する耐タンパ性は主張しない。raw stdout／stderr、session ID、account情報をstate receiptへ保存しない。

## Consequences

- handleを得た瞬間とready確認が分離され、親crash後も同じjobを回収できる。
- current Claude version／Observer installと食い違うbinaryは、起動前のread-only diagnosticsでfail loudになる。
- Agent viewはresearch previewのため、週次CLI更新後はversionとstdout／agents schemaを再characterizationする必要がある。
- live background起動、project fingerprint、MCP限定write、daemon／adapter crash回収はP2-5のH gateとして残る。
