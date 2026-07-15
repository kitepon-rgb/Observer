# ADR 0100: clean install／verify／rollbackを受け入れる

日付: 2026-07-16

## Status

Accepted。P5-2aだけを完了とし、P5-2全体とlive Hは完了扱いにしない。

## Evidence

- Observer `630c5ff`は、runtime package、diagnostics、隔離導入の契約を
  [ADR 0099](0099-clean-install-verify-rollback-contract.md)へ固定した。
- Observer `b45c07a`は、versioned product manifest、sanitized
  `observer diagnostics`、runtime `files`、4 executable binを実装した。
- Observer focusedは12/12、relatedはCLI、MCP、hook config、parent hookを含む
  32/32、`npm run check`はgreenだった。
- `npm pack --dry-run --json`はruntime 53 filesだけを列挙し、4 binを
  mode 0755で収録した。test、rag、active plan、archiveは含まれない。
- dotagents `894799b`は、installed packageの4 command、product／MCP
  diagnostics、version、schemaをexact検証する入口とmulti-repo gateを追加した。
- dotagents focusedは、隔離HOME／npm prefixで実Observer tarballを
  install→reinstall→verify→rollbackし、installed hook adapterのdry-runを通した。
  rollback後はObserver packageと4 commandだけが消え、無関係file、
  Claude／Codex設定、credential sentinelは不変だった。
- dotagents relatedは既存hook transaction、clean-home install、shellcheck、
  Markdown 77 filesを通し、指摘は0だった。

## Decision

P5-2aを受け入れる。実HOME apply、hook trust、live host、credential、publish、
pushは実施しておらず、Hまたは後続gateに残る。latency実測とcleanupを含む
P5-2の残件も未完了である。full regressionと独立重監査はPhase O2 gateへ残す。
