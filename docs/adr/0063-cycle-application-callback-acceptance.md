# ADR 0063: cycle application callbackを受け入れる

日付: 2026-07-15

## Status

Accepted。commit `fc51157`の`applyCycle`／`finalizeAppliedCycle` production callback coreだけを受け入れる。
外部Supervisor caller、provider routing、公開CLI、live host requestを完了扱いにしない。

## Accepted behavior

- canonical cycle inputをgeneric operationのinput digest／model-visible bytesへ照合し、そのevidence context内の
  target／watch／cycle／provider／parent threadだけをMailbox配送identityとして使う。
- generic completed operationのcanonical output／digest／作成時刻を再読し、callback引数だけから外部効果を作らない。
- no-advisoryは決定的no-op result、advisoryはoperation ID由来message IDとdurable時刻から24時間の有効期限を持つ
  strict messageを作り、`publishOperationMessage`のrecord-first exact replayへ接続する。
- publish後・generic applied前の再実行は同じcontent digestを回収し、applied後のfinalizeだけがpublish receiptをcleanupする。
- cycle inputと異なるthread、operation identity、canonical output、result digest、期限切れをfail loudにする。

## Verification

- focused: `node --test test/cycle-application.test.mjs` — 4 PASS / 0 FAIL / 0 SKIP。
- related: `node --test test/cycle-application.test.mjs test/mailbox-store.test.mjs test/model-operation-store.test.mjs test/supervisor-cycle.test.mjs`
  — 40 PASS / 0 FAIL / 0 SKIP。
- static: `npm run check`、`git diff --check` — PASS。
- full regressionはPhase O2 gateへ集約するため未実行。

## Remaining

- 一target一process lock、evidence input構築、Codex provider callback routing、`runSupervisorCycle`の一step実入口を接続する。
- Claude公開非対話deliveryはlive H gateまで`provider_unavailable`として分離する。
