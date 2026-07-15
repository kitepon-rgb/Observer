# ADR 0113: Claude characterization diagnostic receiptを受け入れる

日付: 2026-07-16

## Status

Accepted。P5-1b3c非Hを完了し、P5-1b3dを次のH gateとする。Claude background job、
model request、host config変更は本waveで実行していない。

## Evidence

- design: [ADR 0112](0112-claude-characterization-diagnostic-receipt-contract.md)
- implementation: `f239a07`
- focused: `test/claude-characterization.test.mjs` 9/9
- related: characterization、product diagnostics、live preflight、Claude model operation、
  Observer AI contract 29/29
- static: `npm run check` green
- package: dry-run 57 files、characterization bin／core収録
- actual read-only readiness: Claude Code `2.1.210`、`status=ready_for_h`、
  `reply_surface=unsupported`

## Decision

prepare／verification／cleanup schemaをv2とし、canonical `capture.json`とは別に0600の
`hook-receipt.json`を追加した。receiptはhook invocation、Stop payload、cwd一致、session digest、
result capture、bounded failure codeだけを持ち、raw stdin、session ID、cwd、model result、prompt、
host logを保存しない。

invalid UTF-8、JSON、Stop payload、canonical Observer resultを独立分類する。入力またはresultが
不正でもdiagnostic receiptを安全に作れた場合はhook command自体を成功終了し、hook未発火へ
丸めない。成功capture、同一replay、別event conflict、session不一致、terminal exact result、
未知file拒否cleanupを維持した。公開CLI testはUnixで実shebang、WindowsでNode executableを使い、
packageの実入口差も固定する。

次はP5-1b3dである。目的、影響、rollbackを示した別のH承認前にClaudeを再起動しない。
P5-1b3dの成立結果なしにP5-1b4を部分実装しない。full regressionと独立重監査はPhase O2完了時に
一回だけ行う。
