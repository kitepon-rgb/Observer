# Codex hook 一次資料メモ

**取得日:** 2026-07-14

**確度:** primary / current-release source

## 公式Hooks

- 出典: https://learn.chatgpt.com/docs/hooks.md
- 取得: `markitdown`。出力30,585 bytesを確認し、rcだけでなくbyte数で成功判定した。
- 関連節: `Stop`
- 短い原文抜粋: “Plain text output is invalid for this event.”

同節は、exit 0ではJSONを要求し、`decision:"block"`と非空`reason`でCodexを継続し、reasonをcontinuation promptにすると規定する。

## Codex 0.144.3 実装

- 出典: https://github.com/openai/codex/tree/rust-v0.144.3
- 取得: GitHub raw source
- 関連ファイル:
  - `codex-rs/hooks/src/events/stop.rs`
  - `codex-rs/core/src/session/turn.rs`
  - `codex-rs/core/src/hook_runtime.rs`
- 現行バイナリ内蔵schemaも`codex-cli 0.144.3`から照合した。

実装はStopのblock reasonをhook promptへ変換し、同じ`run_turn` loopを継続する。`continue:false`が一件でもあればblockより優先する。

## Codex 0.144.3 MCP承認

- 出典: https://github.com/openai/codex/tree/rust-v0.144.3
- 取得: GitHub APIのtag指定raw source
- 関連ファイル:
  - `codex-rs/core/src/mcp_tool_call.rs`
  - `codex-rs/config/src/mcp_types.rs`

custom MCP toolの既定approval modeは`Auto`である。tool annotationに`read_only_hint=true`が無い場合は承認対象となり、非対話実行では取消されうる。`McpServerConfig`はserver既定とtool単位の`approval_mode`、`enabled_tools`、`tool_timeout_sec`を持つ。
