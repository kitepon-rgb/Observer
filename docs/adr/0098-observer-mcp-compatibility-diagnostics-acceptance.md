# ADR 0098: Observer MCP compatibility diagnosticsを受け入れる

日付: 2026-07-16

## Status

Accepted。production AI tool surface、P2-5全体、live provider deliveryは未完または無効のまま維持する。

## Accepted scope

- `observer-mcp`をread-only compatibility／diagnostics surfaceとして維持し、package
  `bin.observer-mcp`、`--stdio`、`--version`の既存契約を変更していない。
- `observer-mcp --diagnostics`は`observer.mcp_diagnostics.v1`一件をstdoutへ返し、version、対応protocol、
  exact `observer_read`／`observer_wait`、`production_ai_surface=disabled`を決定的に報告する。
  state、Throughline、network、credential、host processを読まない。
- MCP serverはliveなprovider／target／watch／projectのexact一致後だけThroughline公開clientを呼ぶ。
  write toolは存在せず、cancel、bounded newline JSON-RPC、sanitized errorを維持する。
- Claude runtimeのMCP probeはcompatibility sentinelとして残るが、production invocationの
  `--tools`／`--allowedTools`はemptyであり、Observer AIへMCPを公開していない。
- 製品契約を最終裁定へ同期し、MCP greenをlive provider delivery成功へ読み替えないことを明記した。

## Evidence

- design: `d82a6bb`、implementation: `1d85039`。
- focused: `node --test test/mcp-server.test.mjs` — 5 PASS / 0 FAIL / 0 SKIP。
- related: MCP server、Claude host adapter／runtime、read-only execution profile —
  24 PASS / 0 FAIL / 0 SKIP。
- static: `npm run check`、`git diff --check` — green。

## Remaining

- P2-5のClaude／Codex live project write拒否、session相関、hook trustはH gateへ残す。
- 通常hostへの登録、settings適用、credential、live MCP callは実行していない。
- Phase O2監査とfull regressionはPhase完了時に一度だけ行う。
