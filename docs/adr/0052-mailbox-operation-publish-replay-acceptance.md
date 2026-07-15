# ADR 0052: Mailbox operation exact replayを受け入れる

日付: 2026-07-15

## Status

Accepted。model operation専用のMailbox publish replay境界を実装し、一般publishのduplicate拒否を維持した。

## Decision

1. commit `0e7a005`の`publishOperationMessage`を、ADR 0048のrecord-first publish境界として受け入れる。
2. operation IDから決定する`obs-<64 hex>`だけを許し、operation／message／target／content digestの完全一致だけをreplay成功にする。
3. `prepared` receiptからinbox、processing、strict consumer receiptのexact digestだけを回収し、malformed／不足証拠／failed messageはfail closedにする。
4. `prepared` publish receiptが参照するconsumer receiptをretention cleanupから保護する。
5. publish receipt cleanupはcaller申告を証拠にせず、durable `applied` model journalとexact result digestを必須にする。
6. 既存`publishMessage`は同一message IDを同内容でも拒否する従来契約を維持する。

## Verification

- focused: `node --test test/mailbox-store.test.mjs test/mailbox-consumer.test.mjs` — 15件成功、失敗0、skip 0。
- related static: `npm run check` — 成功。
- scoped: `git diff --check -- src/mailbox-store.mjs src/mailbox-consumer.mjs test/mailbox-store.test.mjs test/mailbox-consumer.test.mjs` — 成功。
- Control `observer-p4-provider-binding-20260715`でWorker Reportをrevision 45にimportし、revision 46で親acceptした。
- full regression、live parent hook、network、credential、app UI、意図的障害試験は本TODOでは実行していない。

## Consequence

Supervisorはadvisory applyで本APIを使い、model journalを`applied`へ保存した後だけpublish receiptをcleanupできる。
consumer delivery ackとMailbox publish完了は引き続き別契約である。
