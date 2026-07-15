# ADR 0019: Codex app-server transportはbounded JSONL sessionとして隔離する

日付: 2026-07-15

## Status

Accepted for fake-process implementation。実Codex app-server、model turn、UI、長時間waitは未実行であり、
execution-verifiedまたはproduction host採用とはしない。

## Context

[ADR 0018](0018-codex-host-runtime-boundary.md)はthread／turn／connectionの責務を分離したが、
`codex app-server` processの生成、JSONL framing、request ID相関、切断時のpending request契約は未実装だった。
transportがretryまたは成功推測を行うと、runtime journalの`*_start_unknown`と競合してlogical operationを二重実行し得る。

## Decision

1. canonical Observer rootとCodex executableのowner／mode／identityを確認し、Codex CLI 0.144.3だけを受け入れる。
2. `codex app-server`はshellなし、Observer cwd、allowlist環境、pipe stdioで生成する。process／PIDはdurable handleにしない。
3. wireは1行1JSON、`jsonrpc` headerなし、単調増加integer request IDとする。responseは既存pending IDへexact相関し、
   未知／重複ID、server request、不正UTF-8／JSON、oversize lineをprotocol failureとしてconnectionごと閉じる。
4. stderrは内容を保存せずbyte数だけを上限管理する。error responseのraw payloadも上位へ露出しない。
5. write error、stdout終了、process error／exit時のpending requestはunknownとしてrejectし、自動retryしない。
   logical operationの再実行可否はObserver所有journalを持つ`codex-host-runtime`だけが決める。
6. 今回はfake child processでのみ検証し、実process、model turn、UI、65秒超wait、MCP writeを起動しない。

## Verification

- `test/codex-process-transport.test.mjs`: executable/version、spawn境界、out-of-order response、notification、
  server request、error sanitization、未知ID、process切断を固定する。
- `test/codex-host-runtime.test.mjs`: transport errorを受ける側のdurable unknown／停止相関を維持する。
- `npm run check`を静的gateとして通す。

## Consequences

- Codex transportの不確実性をthread／turn durable stateへ混ぜず、同じObserver project内の再作成可能connectionとして扱える。
- 実Codex binaryとのschema／notification互換はまだcharacterizationが必要であり、fake greenをlive greenへ読み替えない。

## Friction check

manual normalization、reconstructed evidence、alternate recoveryは使用していない。実Codex process、model turn、UI、
session削除、project作成は実行していない。
