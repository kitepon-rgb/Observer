# ADR 0031: bounded evidence snapshot builderを受け入れる

日付: 2026-07-15

## Status

Accepted。Task受入と実装コミットのimmutable証拠として使用後は変更しない。

## Context

successor Control `observer-p4-runtime-20260715`は、Task
`observer-evidence-snapshot-builder-v2`をexecution-verifiedなaiterm Codexへ一件だけ配置した。
Workerは委譲packetとstrict Worker Report skeletonをdispatch前に受け取り、書込scopeを
`src/evidence-snapshot.mjs`と`test/evidence-snapshot.test.mjs`の二ファイルへ限定した。

実装はhost-neutralなsnapshot／receipt公開API、exact keyとavailability relationshipの検証、
canonical digest、UTF-8 byte単位のsection／全体上限、秘密伏字、優先順位付きtruncate／omitを提供する。
receiptは本文、evidence ref、source digestを含まない。

## Decision

strict Worker Reportを手補正せずControl revision 7へimportし、親が実diffと受入契約を確認した。
親は次のfocused gateを再実行し、すべてgreenを確認した。

- `node --test test/evidence-snapshot.test.mjs`: 15/15 passed
- `npm run check`: passed
- `git diff --check -- src/evidence-snapshot.mjs test/evidence-snapshot.test.mjs`: passed

Control revision 8でRunをacceptし、二ファイルだけをcommit `0536d07`へ固定した。
full suite、live host、collector／Supervisor統合はこのTaskの非目標どおり実行していない。

## Consequences

- P4-2のsnapshot builderとstrict validatorは完了とする。
- 次Taskはread-only collectorであり、collector unavailableを空の成功へ丸めずsnapshot inputへ渡す。
- generation state、Supervisor接続、live Observer起動は別Task／別gateのまま継続する。
