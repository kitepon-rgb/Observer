# ADR 0149: Observer 0.1.1をinstalled production runtimeへ届ける

日付: 2026-07-26

## Status

Accepted for execution。上位互換runtimeとfault terminalizationをnpm利用者へ届け、
公開後のinstalled packageでbingo監視を再開するrelease契約とする。

## Context

npm公開版0.1.0はThroughline 0.6.3完全一致とCodex CLI 0.144.3完全一致を要求し、
現行Throughline 0.8.7／Codex CLI 0.144.6をproduction routeで利用できない。
repo mainには上位安定版SemVerの受入れ、truncated evidence境界、Supervisor fault回収の修正があるが、
未push・未公開であり、global installは0.1.0のままである。

## Decision

1. 次版を後方互換bugfixの`0.1.1`とする。package manifest、runtime diagnostics、MCP、
   Codex adapter、fixture、runbook、README、CHANGELOGを同じversionへ同期する。
2. 現在利用者が読むlive文書を更新する。過去ADR、archive、一次資料RAGは当時の証拠として改変しない。
3. Throughlineの公開最低対応版は`>=0.8.7`、Codex CLIは`>=0.144.3`とする。
   version受理後も実command／wire schema検証を必須とする。
4. `npm test`、`npm run check`、`npm run test:package`、`npm pack --dry-run`を公開前gateとする。
5. release commitを`origin/main`へpushし、祖先確認後だけtag `v0.1.1`をpushする。
6. tagとcommitが一致し、worktreeがcleanな状態だけで`npm publish --access public`を実行する。
7. registryで0.1.1を確認後、global installを0.1.1へ更新する。失敗時は0.1.0へ戻せる。
8. installed binaryのdiagnostics／MCP diagnosticsを確認し、そのbinaryからbingo watchを起動する。
   `active`継続を確認するまでrelease完了・作業再開としない。

## Acceptance

- live文書の旧最低版・旧expected versionが残らない。
- package内の全version surfaceが0.1.1で一致する。
- publish対象commitが`origin/main`の祖先で、tagとnpm dist versionが一致する。
- global executableが0.1.1を返し、product／MCP diagnosticsがreadyである。
- bingo projectを変更せず、installed production watchがactiveになる。

## Rollback

- publish前: release commitをrevertし、tagを作らない。
- publish後: 0.1.1をunpublishせず必要ならdeprecatedにし、global installを0.1.0へ戻す。
- watch起動後: 同じforeground callerへSIGINTを送り、managed terminal cleanupを確認する。
