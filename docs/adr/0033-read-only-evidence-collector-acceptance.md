# ADR 0033: read-only evidence collectorを受け入れる

日付: 2026-07-15

## Status

Accepted。Task受入と実装コミットのimmutable証拠として使用後は変更しない。

## Context

successor Control `observer-p4-runtime-20260715`は、Task
`observer-readonly-evidence-collector`をnative implementerへ一件だけ配置した。Workerは委譲packetと
strict Worker Report skeletonをdispatch前に受け取り、書込scopeを`src/evidence-collector.mjs`と
`test/evidence-collector.test.mjs`の二ファイルへ限定した。

実装は承認済みplan ref、git HEAD／status／unstaged diff／staged diff、既存test receiptを
snapshot builderのexact inputへ投影する。project root containment、1 MiB取得上限、固定git argv、
minimal environment、5秒timeout、domain-separated source digestを強制し、取得不能を空の成功へ丸めない。

## Decision

親のpre-import reviewで、継承環境による`GIT_DIR`等の注入、sparse array検証、maxBuffer error分類の
三点を同一Run内で修正した。その後、strict Worker Reportとimport envelopeの完全一致を確認し、
Worker Reportを手補正せずControl revision 16へimportした。親は実diffと受入契約を確認し、次の
focused gateを再実行してすべてgreenを確認した。

- `node --test test/evidence-collector.test.mjs test/evidence-snapshot.test.mjs`: 22/22 passed
- `npm run check`: passed
- `git diff --check -- src/evidence-collector.mjs test/evidence-collector.test.mjs`: passed

Control revision 17でRunをacceptし、二ファイルだけをcommit `4276615`へ固定した。live repo統合、
Supervisor配線、generation state、live Observer起動はこのTaskの非目標どおり実行していない。

## Consequences

- P4-2のread-only collectorは完了とする。
- collectorの利用不能sourceは固定code付き`available=false`としてbuilderへ渡り、claim可否を曖昧にしない。
- 次Taskはgeneration stateとplanned rollover契約であり、8 cycle／256 KiB到達前の世代交代を実装する。
