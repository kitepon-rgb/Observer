# ADR 0099: clean install／verify／rollbackを製品manifestへ束縛する

日付: 2026-07-16

## Status

Accepted for implementation。実HOME apply、host設定、hook trust、credential、registry publishは行わない。

## Context

Observerは4 binaryとruntime sourceを持つが、npm packageの`files`、製品diagnostics、clean install、rollbackの
公開契約がない。`bin/observer.mjs`だけgit modeが`100644`であり、source checkoutを直接使う入口では実行不能に
なり得る。dotagentsはparent Stop hook設定adapterを持つが、installed Observer package全体を検証していない。

live hostへ直接installしてから不備を探すと、既存file、host設定、credential、現在稼働中のCLIを巻き込む。
Observer所有のpackage contractと、dotagents所有の工場配布adapterを分けたclean fixtureが先に必要である。

## Decision

1. `package.json#files`を`AGENTS.md`、`CLAUDE.md`、`bin/`、`src/`へ固定する。package.jsonはnpm標準で
   自動同梱される。test、rag、active plan、archive、local configをruntime packageへ含めない。
2. `observer.product_manifest.v1`をObserver sourceで所有し、次をexact固定する。
   - product名／version、supported platform=`darwin`
   - state root templateとowner-only mode
   - 4 binaryのname／relative path
   - Node、Throughline、Claude Code、Codex CLIの対応versionと利用scope
   - native product diagnosticsとMCP diagnosticsの公開入口
3. `observer diagnostics`は自身のcanonical package root、package manifest、
   AGENTS／CLAUDE、4 binaryの
   regular file・non-symlink・owner executable mode・shebang、Node runtimeをread-onlyで検証する。
   absolute install path、HOME、username、credential、env、file digestをresultへ出さない。
4. 成功resultは`observer.product_diagnostics.v1`一件とし、manifestと固定checkだけを返す。macOSでは`ready`、
   Linux／Windowsではpackage integrityがgreenでも`unsupported_platform`を返し、成功や自動fallbackへ丸めない。
   package／bin／Node不一致は固定Observer error codeで非0終了する。
5. 全4 source binを`100755`へ揃える。npm tarballとinstalled prefixでも同じ4 commandが生成され、
   `observer diagnostics`と`observer-mcp --diagnostics`がexact schemaを返すことをfixtureで確認する。
6. dotagentsは隔離HOME／npm prefixだけでcandidate tarballを
   install→reinstall→verifyする。既存のunrelated fileと
   host設定を変更せず、rollbackではcandidate導入前のpackage状態またはabsent状態へ戻す。
7. dotagents hook adapterはinstalled `observer-hook-config`／`observer-parent-stop-hook`を使うdry-runと
   隔離candidate verifyだけを行う。CLI欠損、version／schema不一致をfail loudにする。
8. Observer repoとdotagents repoは独立commit／独立gateにする。実HOME apply、hook trust、live host、publish、
   pushは本Taskで実行しない。

## Acceptance

- Observer focused: product diagnostics schema、package tamper、
  bin mode／symlink、Node version、platform status。
- Observer related: CLI、MCP diagnostics、hook config／parent hookの公開binary契約。
- dotagents focused: isolated npm prefixのinstall／reinstall／verify／rollbackと
  installed hook adapter dry-run。
- static gateを各repoで一度ずつ通し、full regressionはPhase O2 gateへ残す。
