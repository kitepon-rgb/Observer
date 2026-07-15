# ADR 0051: model operation coreの回収不能windowを閉じる

日付: 2026-07-15

## Status

Accepted for corrective implementation。ADR 0049の受入後、Supervisor統合前の独立反証で見つかった
4件のP1を同じcoreへ戻して修正する。

## Context

[ADR 0050](0050-supervisor-model-operation-integration-contract.md)のcrash matrixを既存store実物へ反証したところ、
二重送信は防げても結果を回収不能にするwindowが残っていた。

1. process deathで`model-operation.lock`が残るが、model storeにinspect／nonce recovery surfaceが無い。
2. `dispatching -> completed`をprovider receipt無しで許すため、callback return後・generic保存前crashでresult locatorを失う。
3. generationが`rollover_requested`を先に保存した後のcrashでは、再reserveがactive前提で失敗しprepared cleanupへ戻れない。
4. `cleanupAppliedModelOperation`がprocessed cycleを照合せず、call順序を一箇所誤るだけでcanonical outputとapplied resultを失う。

## Decision

1. `inspectModelOperationLock({stateRoot,targetId})`と
   `recoverModelOperationLock({stateRoot,targetId,expectedNonce})`を追加する。既存private lockと同じowner recordを使い、
   nonce未指定、nonce不一致、未知fileを拒否する。時刻だけで自動削除しない。
2. Supervisor／運用層は`E_CONSUMER_LOCKED`を成功やresult unknownへ丸めない。owner PIDの終了を外部証拠で確認した後、
   read-only inspectで得たnonceを明示してrecoverし、同じoperation statusから再開する。store自身はPID生存を推測しない。
3. `completeModelOperation`はdurable `accepted`からだけ許す。`dispatching -> completed`の同期shortcutを廃止する。
   issue／recover callbackの`completed` outcomeにもprovider固有journalへexact result locatorを耐久化済みの
   `provider_operation_receipt_digest`を必須とし、Supervisorは`accept -> complete`の順で保存する。
4. `reserveModelOperation`はmatching generationが`rollover_requested | stopping | terminal_confirmed`で、
   journalが`prepared`、generation pending reservationがnullなら、未送信のplanned rollover recoveryとして
   `rollover_required`を返す。generation storeのactive reserveを再実行しない。
5. current generationが既に次sequenceへ進んでいても、同じtarget／watch／cycle／input／bytes／providerの旧journalが
   `prepared`なら未送信と証明できるためcleanupし、新generation IDで新しいoperationを作れる。
   `reserved`以降、identity不一致、matching外のpreparedは自動cleanupしない。
6. `cleanupAppliedModelOperation`は、同targetのpending cycleがdurable `processed`であり、watch／cycle／input digest／
   model-visible bytes／result digestがapplied journalへ完全一致することをcycle storeから読んでからだけ削除する。
   caller提供objectをprocessed証拠として信用しない。
7. cycle processedが既にcommitされpending receiptが無い場合はcleanupを成功させない。正規順序ではmodel journal cleanupが
   commitより先であり、この状態は別の履歴修復を要するためである。
8. ADR 0049は当時の受入Decision証拠として改変しない。本ADRと後続corrective acceptanceを新しい証拠にする。

## Crash matrix

- journal write後・lock release前crash: inspectでowner／nonceを確認し、owner終了証拠後だけ明示recoverしてdurable statusから再開する。
- provider completed後・generic completed前crash: durable provider receiptからrecover callbackが同じraw resultを再読する。
- generation rollover write後・prepared cleanup前crash: generation statusとreservation nullをexact照合してrollover_requiredへ回収する。
- next generation開始後・旧prepared残存: 未送信preparedだけをcleanupし、新generation operationを作る。
- applied後・processed前cleanup誤呼出し: storeが`E_MODEL_OPERATION_CLEANUP_FORBIDDEN`で拒否する。
- processed後・model cleanup前crash: matching processed receiptを照合し、applied journalだけをcleanupする。

## Rejected alternatives

- lock ageで自動回復する案: 遅いlive ownerとcrashed ownerを時刻だけで区別できない。
- completed callbackのraw outputをgeneric journalより先に別fileへ複製する案: provider固有locator責務をgeneric coreへ混ぜる。
- rollover_requestedをactiveへ戻してreserveを再試行する案: generation stateを後退させる。
- cleanup call-site順序testだけで守る案: canonical resultの所有権移管を公開store APIが強制しない。

## Acceptance

- focused fixtureで残留lock inspect／wrong nonce拒否／explicit recover、dispatching completion拒否、accepted completion、
  rollover_requested recovery、旧prepared cleanup、processed照合付きapplied cleanupを固定する。
- existing core testを修正し、processed receipt無しのapplied cleanupが失敗することを確認する。
- Supervisor統合Taskはこのcorrective commitへ依存し、古いstore契約をfakeで再現しない。
