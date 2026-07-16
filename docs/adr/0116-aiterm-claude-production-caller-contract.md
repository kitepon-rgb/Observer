# ADR 0116: Aiterm Claude production caller契約

日付: 2026-07-16

## Status

Accepted for implementation。P5-1b4を4つの順序付きTODOへ分解し、P5-1b4aから実装する。

## Doctrine

- Observer cognitionは、親と同providerの利用者可視な一つの永続AI sessionが所有する。
- Throughline L2は親completed chain／rollback証拠であり、Observer sessionの記憶を代替しない。
- SupervisorはAIではない。delivery、exact-once、timeout／crash recovery、generation、Mailbox publishだけを
  管理するNode control processである。
- AitermはClaude TUI transportだけを所有し、Observer／Throughline／Mailbox意味論を持たない。

## Public boundary

1. ObserverはAiterm stdio MCPだけを使う。protocolはnewline JSON-RPC、initialize
   `2025-11-25`、server version `0.13.0`、必須toolは`claude_agent`／`claude_turn`／`pty_close`とする。
   executable identityはspawn前と各公開操作前に再検証する。
2. launch handleは新規production routeで`claude.session`とし、Aiterm
   `aiterm.agent-launch-result.v1`のstructured `session_id`だけから作る。人間向けtextを解析しない。
   旧`claude.job`はblocked background characterizationの履歴互換としてのみ読めるよう残す。
3. launchはcanonical Observer runtime rootをcwdとするpromptless managed `claude_agent(agent_done:true)`。
   session生成receiptをTUI readyやmodel成功とは扱わず、最初のcycle `claude_turn issue`がready gateを通る。
4. 一つのactive generationの全completed cycleは同じ`claude.session`へ送る。`claude -p`反復、
   private transcript／debug protocol、CodexやAPIへのfallbackは禁止する。

## Operation mapping

1. generic `issue_once`前にcycle inputのdigest／byte数／canonical JSONを再検証する。
2. `claude_turn issue`はgeneric operation IDをそのまま使う。`accepted`はprovider accepted、`completed`は
   exact raw output、`unknown/operation_not_found`は`provider_operation_missing`、
   `unknown/result_unknown`は`provider_result_unknown`へ固定変換する。
3. generic `recover_only`は`claude_turn recover`だけを呼び、promptを再送しない。`pending`はgeneric pending、
   `completed`は同じreceipt／output digestを再検証する。
4. Observerはprovider journalへsession、operation、generation、receipt digest、completed output digestだけを
   owner-onlyで保存する。prompt／model output本文はgeneric model operation store以外へ複製しない。
5. cleanupはgeneric completed証拠とprovider journalが一致した後だけObserver journalを除去する。
   Aitermのsession-owned operation証拠はsession close時にAitermが除去する。

## Process and lifecycle

- Aiterm MCP processとClaude PTY sessionは別寿命である。MCP transport再接続時もprivate watch bindingの
  `claude.session`へrecoverでき、同一operationを再送しない。
- 親callerはcurrent Claude parent、watch reservation、Aiterm verification、session launch、spawn／ready receipt、
  initial generationをdurable順序で確定してからSupervisor loopへ所有権を渡す。
- 通常終了は`pty_close`成功後にMCP processを終了する。一次失敗とclose失敗はAggregateErrorで両方保持する。
- rollback／parent rebindは通常cycleと分離し、generation authorization後だけstop／relaunchする。
  実装前は未対応経路をsuccessへfallbackせず明示errorにする。

## Acceptance

- fake Aiterm MCPでinitialize／tool schema、launch structured receipt、issue accepted、recover pending／completed、
  unknown二種、tool error、cleanupを固定する。
- production stepがClaude／Codexをprovider別callbackへ振り分け、Claude cycle間で同じsession IDを使う。
- process abort、Aiterm transport終了、watch停止、session close失敗をsanitized terminal／faultへ分離する。
- 実Claude model request、login、credential、publish、push、端末設定適用はP5-1b5 Hまで行わない。

## Rollback

P5-1b4の独立commitを逆順revertし、Aiterm transport、Claude provider operation、`claude.session` route、
Claude caller／CLIだけを除去する。Codex caller、旧blocked characterization harness、Throughline、Mailboxは変更しない。
