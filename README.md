# Observer

Observerは、ClaudeまたはCodexで動く親AIの確定ターンをread-onlyで観測し、成果を
有意に改善できる時だけ、証拠付きの助言を返す伴走プロダクトです。正常進行では
沈黙し、監視対象のコード・設定・工程を変更しません。

**工場での役割:** Observerはdotagents開発工場が管理する自作コア10製品の一つです。
macOS上のread-only伴走監視を所有し、dotagentsが製品横断の導入・統合契約を所有します。

## 対応環境

- 製品runtime: macOS
- Node.js: 22.13以上
- 親host: Claude Code / Codex
- completed-turn feed: Throughline 0.6.3以上（現行工場版は0.8.7）

Linuxではhost-neutral testとpackage検査を実行できますが、製品診断は
`unsupported_platform`を返します。

## インストール

```bash
npm install --global @quolu/observer
observer diagnostics
observer-mcp --diagnostics
```

監視は利用者が親AIへ明示的に依頼した時だけ開始します。自動起動、自動再起動、
監視対象への書込みは行いません。

## 公開CLI

```bash
observer diagnostics
observer watch /absolute/path/to/project
observer watch status /absolute/path/to/project
observer watch stop /absolute/path/to/project
```

host adapterの導入とlive運用は、
[`docs/observer-live-campaign-runbook.md`](https://github.com/kitepon-rgb/Observer/blob/main/docs/observer-live-campaign-runbook.md)
および製品契約に従ってください。

## 開発

```bash
npm ci
npm test
npm run check
npm run test:package
```

publishは、対象commitが`origin/main`へ着地済みで、working treeがcleanな時だけ
`prepublishOnly` gateを通過します。

## License

MIT
