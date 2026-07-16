# ADR 0119: Claude production caller core受入

日付: 2026-07-16

## Status

Accepted。P5-1b4cを完了し、次のready TODOをP5-1b4dとする。

## Decision

- `runSupervisorProductionStep`はactive generationのproviderに応じ、Codexの既存callbackとClaudeの
  `issueClaudeModelOperation`／`recoverClaudeModelOperation`／`cleanupClaudeModelOperation`を分岐する。
  Claude operationへ渡すruntimeはexactな`{session_id}`だけとし、Aiterm transportは`callTool` dependencyに置く。
- Claude provider runtimeは一つのAiterm MCP transportとprivate watch bindingの`claude.session`をprocess lease全体で
  所有する。一つのactive generationの通常completed cycleは同じsession IDを再利用し、`claude -p`反復、prompt再送、
  Codex/API fallbackを行わない。
- Claude親callerはproduct diagnostics、Throughline verification、Aiterm verification、current Claude parent、watch予約、
  promptless session launch、active binding、initial generationの耐久順序を確認した後だけ、同じruntimeをSupervisorへ
  一度だけ譲渡する。initial generationは`activateAitermClaudeObserver`が所有し、callerから二重初期化しない。
- 通常終了は`pty_close`を先、MCP process closeを後に行う。一方、session launchが確定する前のruntime cleanupはMCPだけを
  閉じ、結果不明のsessionを勝手に破壊してrecover不能にしない。session closeとMCP closeが両方失敗した場合は
  `AggregateError`で双方を保持する。
- standalone Supervisor CLIは保存済み`claude.session`へattachし、親CLIは新規sessionをlaunchする。provider commandの
  混在を拒否し、既存Codex既定CLIを維持する。
- planned rolloverとparent rebindはP5-1b4dまで未実装であり、明示`unavailable` errorを返す。未実装経路を成功、
  provider切替、再launchへfallbackしない。

## Evidence

- focused: `node --test test/supervisor-production-step.test.mjs test/supervisor-claude-process.test.mjs test/claude-parent-caller.test.mjs test/cli.test.mjs`
  — 27 passed、0 failed、0 skipped。
- related: Aiterm transport／Claude operation／Claude host runtime／launch／watch／Supervisor process／Claude・Codex caller／CLIの
  12 test file — 91 passed、0 failed、0 skipped。
- static: `npm run check` green。
- 親反証: duplicate spawn、duplicate generation、unknown後のprompt resend、cross-provider fallback、session/MCP close順序を
  実diffとfixtureへ突き合わせ、P0/P1相当の反例なし。
- full regression、独立重監査、実Claude model request、login、credential、publish、pushは未実施。fullと独立重監査は
  P5-1b4dで19dを閉じる時、live HはP5-1b5で一度だけ行う。

## Doctrine preservation

Throughline L2は親completed chain／rollback証拠であり、Observer cognitionではない。Observer cognitionは同providerの
利用者可視な永続AI sessionが所有する。SupervisorはAIではなく、delivery、exact-once、recovery、generation、Mailbox
publishだけを管理するNode processである。本変更はこの境界を変えない。

## Rollback

本commitをrevertし、Claude production step dispatch、Claude runtime/process、Claude parent caller／CLI、専用fixture、
本ADRを除去する。P5-1b4a／bのAiterm transport、Claude operation、`claude.session` launchと既存Codex callerは維持する。
