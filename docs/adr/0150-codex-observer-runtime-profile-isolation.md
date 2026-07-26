# ADR 0150: Codex Observer子を親AI向けhook／pluginから隔離する

日付: 2026-07-26

## Status

Accepted for execution。

## Context

Observer 0.1.1は上位安定版Throughline／Codex CLIを受理できたが、installed production watchの
bootstrapでCodex turnが外部`interrupt`を受ける事象を再現した。同じapp-server契約を隔離stateで
実行すると成功する一方、成功時にもObserverの役割に不要なユーザー全体のlifecycle hookとplugin由来の
MCP startupが多数起動していた。

Observer AIはcanonicalな`observer.child_start.v1`／`observer.cycle_request.v1`だけを評価し、
shell、MCP、plugin、外部toolを使わない。親AI向けのhook／pluginを継承することは製品役割に不要で、
bootstrapの可用性とread-only境界を利用者環境へ依存させる。

## Decision

1. Codex app-serverを`--disable hooks --disable plugins`付きで起動する。
2. Codex executable、Observer cwd、環境allowlist、detached process group、read-only turn policyは維持する。
3. failed／interrupted／timeoutを別turnへ暗黙再送しない既存契約は維持する。
4. focused／full／package gate後に0.1.2を公開し、installed binaryからbingo watchを一度だけ起動する。
5. watchが`active`を維持し、foreground callerが存続していることを公開後の完了条件とする。

## Acceptance

- process transport testがhook／plugin無効化引数をexact検証する。
- Codex host／parent caller関連testとfull regressionがgreenである。
- package内容と全version surfaceが0.1.2で一致する。
- installed 0.1.2のproduction watchがbootstrapを完了し`active`になる。

## Rollback

- npm公開前は変更commitをrevertする。
- 公開後は0.1.2をunpublishせず、必要ならdeprecatedにして0.1.1へglobal installを戻す。

## Outcome

0.1.2のcommit／push／tag／npm publish／global install／diagnosticsを完了した。
installed production bootstrapはhook／plugin eventなしで完了し、本ADRの隔離を実証した。
その後、target単位の旧generation stateが新watch初期化を拒否する別欠陥を検出したため、
`active`継続は[ADR 0151](0151-new-watch-generation-replacement.md)へ引き継ぐ。
