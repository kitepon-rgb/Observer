# ADR 0053: model operation回収不変条件の補正を受け入れる

日付: 2026-07-15

## Status

Accepted。ADR 0051で確定した4件の回収不能windowと、次generation開始後の旧`prepared`残留を閉じた。

## Decision

1. commit `8afebca`のmodel operation store補正を受け入れる。
2. model lockはread-only inspectとexpected nonce指定recoverだけを公開し、時刻による自動削除を行わない。
3. `completeModelOperation`はdurable provider receiptを持つ`accepted`からだけ許し、`dispatching -> completed` shortcutを廃止する。
4. same-generationのplanned rolloverは、未送信`prepared`かつreservation nullの時だけ`rollover_required`へ回収する。
5. 次generation開始後に残った旧`prepared`は、provider／target／watch／cycle／input／bytesとcurrent generationが完全一致する時だけ、新operationへatomic replaceする。`reserved`以降は置換しない。
6. `cleanupAppliedModelOperation`はdurable cycle storeのmatching `processed` receiptを読み、watch／cycle／input／bytes／result digestが完全一致した時だけjournalを削除する。

## Verification

- focused＋related: `node --test test/model-operation-store.test.mjs test/cycle-store.test.mjs test/mailbox-store.test.mjs` — 27件成功、失敗0、skip 0。
- related static: `npm run check` — 成功。
- scoped: `git diff --check -- src/model-operation-store.mjs test/model-operation-store.test.mjs` — 成功。
- Control `observer-p4-provider-binding-20260715`でWorker Reportをrevision 48にimportし、revision 49で親acceptした。
- full regression、live provider、network、credential、app UI、意図的障害試験は本TODOでは実行していない。

## Consequence

Supervisor統合は、provider固有receiptを必ず`accepted`へ保存し、cycleを`processed`へ移管した後だけmodel journalをcleanupする。
残留lockは運用層がowner終了を外部確認した後にだけ明示recoverする。
