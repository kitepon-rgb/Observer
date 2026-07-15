# Claude background Observer read-only境界の実測

**出典:** Claude Code CLI 2.1.207の`--help`／background job公開CLI、ローカル隔離repo実測
**取得日:** 2026-07-15
**確度:** 組込みtool allowlist・一回のwrite拒否・job lifecycle=高、CLI process全体の非変更性・実行中stop・Observer MCP write・65秒超継続・daemon crash回収=未検証

## 結論

- `claude --bg`はClaude親と同じClaude CodeのAgent一覧へjob IDを公開し、`agents --json`で
  `working → done`を追跡できる。
- `--permission-mode dontAsk`、strictな空MCP、exact tool allowlist `Read,Grep,Glob`では、
  project読取は成功し、一回の書込依頼は`Write` tool不在によって拒否された。
- これはLLMへ公開した組込みtool surfaceの実証であり、settings／hooks／pluginsを含むCLI process全体の
  project非変更性ではない。production gateには実行前後fingerprintが必要である。
- `--tools`と`--mcp-config`は可変長である。prompt positionalより前に置くと、後続flagやpromptを
  値として取り込む。固定長flag → prompt → 可変長flagの順を守る。
- terminal後にbackground daemonが終了すると、`claude logs <id>`は`control.sock`不在で回収不能に
  なりうる。adapterは起動中にbounded receiptを回収・耐久化し、private job state直読を標準fallbackにしない。

## Characterization receipt

- 成功job: `52eb5a00`。README読取成功、write試行はtool不在で失敗、sentinel不在を親が確認。
- lifecycle: 公開一覧で`working`から`done`へ遷移。同じhandleへのterminal後stopは成功し、`done`を保持。
  実行中stop、子process消滅、再stopは未実測。
- 先行失敗: `200c4937`と`327b0365`。可変長flagのargv順序誤りにより初期化前exit 1。
- late logs: daemon終了後は公開socket不在で回収失敗。成功へ丸めない。

詳細な不変判断は[ADR 0010](../../docs/adr/0010-claude-background-readonly-characterization.md)。

## 設計への還流

- Claude provider handleはjob IDとして型を分け、Codex thread／turn handleと統合しない。
- production gateはsettings／hooks／plugins隔離、workspace fingerprint不変、Observer MCP限定write、
  65秒超継続、実行中stop、即時完了／adapter／daemon crash後のreceipt回収。
- 親の明示指示なしにbackground Observerを起動しない。
