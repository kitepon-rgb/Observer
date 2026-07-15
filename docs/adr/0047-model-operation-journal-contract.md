# ADR 0047: model requestの結果不明を独立operation journalで回収する

日付: 2026-07-15

## Status

Accepted for implementation。host-neutral coreとfake callback fixtureだけを本Taskで受け入れ、
実Claude／Codex model request、network、credential、app UIはH gateに残す。

## Context

[ADR 0036](0036-cycle-generation-exact-once-transaction.md)は、generation reservationが既に存在する時に
`processCycle`を再実行せず`model_result_unknown`で止める。これは二重送信を防ぐが、reservation後・model前と、
model結果後・cycle processed保存前を区別できず、同じoperationの結果を回収する公開境界もない。

[ADR 0042](0042-generation-provider-binding-recovery-contract.md)により、model operationはhost generationの
stop／spawn／ready journalと状態、lock、受入を分ける必要がある。prompt、raw model output、raw host handle、
tool logをdurable stateへ保存することもできない。

## Decision

1. target directoryへ`model-operation.json`と`model-operation.lock`を追加する。host lifecycleの
   `generation-host-rollover.json`／lock、provider固有journal、cycle pendingとは別schema・別lock・別受入にする。
2. journal schemaは`observer.model_operation.v1`とし、provider、target／watch／generation／cycle ID、
   input digest、model-visible bytes、決定的operation ID、status、provider operation receipt digest、
   strict parse済みcanonical AI output、output／applied result digest、timestampsだけを持つ。
   prompt、input value、turn本文、raw provider output、raw provider handle、tool logは保存しない。
3. operation IDは上記identityをdomain separationしたdigestとする。同じcycleでもgenerationまたはinputが違えば
   別operationになり、既存journalとの不一致はconflictとしてfail closedにする。
4. state machineは`prepared -> reserved -> dispatching -> accepted -> completed -> applied`を基本順序とする。
   synchronous completionは`dispatching -> completed`を許すが、後退とstep飛ばしは明示した経路以外拒否する。
   - `prepared`: journalはdurableだがgeneration reservationは未確認で、provider未送信。
   - `reserved`: matching generation reservationを新規作成または冪等確認済みで、provider未送信。
   - `dispatching`: provider callbackを呼ぶ直前にatomic replace済み。call直前crashも受理後のresponse lossも
     区別できないため、以後は新しいmodel requestを送らず同じoperation IDの`recover_only`だけを許す。
   - `accepted`: provider固有journalでexact operation handleを耐久化したreceiptを確認済み。generic journalは
     raw handleを複製せずreceipt digestだけを持ち、同じhandleのpollだけを許す。
   - `completed`: raw provider outputをmemory内でstrict parseした、16 KiB以下のcanonical
     `observer.ai_output.v1`本体とdigestを回収済み。
   - `applied`: canonical outputをidempotentな適用境界へ渡し、exactな`observer.cycle_result.v1`を耐久化済み。
5. Supervisorはinput構築後、generation reservationより先にmatching `prepared` journalを作る。crash後に同じinputを
   再構築し、既存`prepared`と一致する時だけreservationを作成／確認して`reserved`へ進める。journal欠損を
   「未送信」と推測して既存reservationから新規作成せず、`model_result_unknown`で止める。cutover前に作られた
   reservationの暗黙migrationもしない。
6. model request callbackへはraw-freeなoperation receiptと`action=issue_once`を渡す。callbackの直前にjournalを
   `dispatching`へ進めるため、callback throw、process crash、connection lossはすべて再送禁止になる。
7. `dispatching`／`accepted` recoveryは別のcallbackへraw-free operation receiptと`action=recover_only`だけを渡す。
   非永続input valueを再供給せず、provider固有journal／handleから同じoperationだけを照合する。provider handleまたは
   client operation keyが無い場合は回収可能と偽らずunknownのまま止める。
8. provider resultは`parseObserverAiOutput`でstrict parseし、canonical objectと
   `observerAiOutputDigest`の一致を検証して`completed`へ保存する。digestだけから`no_advisory`／advisory本文を
   再構成しない。canonical output本体のdurable保存を禁止する構成では、exact provider handleから安定再読できない限り
   completed recoveryは未実装として止める。
9. `completed` recoveryはmodelを呼ばずcanonical outputをidempotentな`applyCycle`へ再適用する。
   callbackにはoperation IDを渡し、外部効果はそのIDから決定したdedupe identityでexact replayできなければならない。
   `applied`へはcallbackのexact cycle resultだけを保存する。
10. `markCycleProcessed`がmatching input／applied resultをdurable化した後にだけmodel operation journalを削除する。
   以後の正本はpending cycle v2である。processed recoveryは残存するmatching applied journalを先に削除してから、
   既存のcursor／generation commitを再開する。prepared／reserved／dispatching／accepted／completedを
   processed成功として削除しない。
11. planned rolloverでmodelを未送信のまま止める時はmatching `prepared` journalだけを明示cleanupできる。
    `dispatching`以降をrolloverや新generation開始で消したり、別generationへ引き継いだりしない。
12. Mailbox適用ではoperation IDから決定的message IDを作り、同一ID・同一canonical contentの再publishを
    冪等成功、同一ID・異なるcontentをconflictにする必要がある。現行`publishMessage`は同一IDを一律duplicateにするため、
    P4-2 integrationより前の独立F契約／gateで修正し、fake callback成功を実Mailbox適用済みに読み替えない。

## Crash matrix

- input構築後・journal作成前: durable operationなし。同じinputを再構築して通常開始できる。
- prepared作成後・reservation前: matching preparedからreservationを作成する。
- reservation後・reserved保存前: generation reservationをexact照合してreservedへ進める。
- reserved後・dispatching前: atomic遷移後に一度だけissueする。
- dispatching後・provider call前後: 送信有無を証明できないため自動再送せず、recover-onlyへ進む。
- provider accepted後・generic accepted保存前: provider固有journal／client operation keyが無ければunknownのまま止める。
- accepted後・result前: exact handleだけをpollし、新しいrequestを送らない。
- provider result後・completed保存前: 同じhandleから再読する。回収不能はunknownのまま止める。
- completed保存後・apply前: canonical AI output本体をmodel再実行なしでidempotent applyする。
- Mailbox publish後・applied保存前: deterministic message IDのexact replayで同じpublish receiptを回収する。
- applied保存後・cycle processed前: matching resultだけをpending cycleへ移管する。
- cycle processed後・model journal削除前: processedを正本としてmatching applied journalだけを削除する。
- model journal削除後・cursor／generation commit前: pending cycle v2から既存exact-once commitを再開する。

## Rejected alternatives

- `prepared`をprovider call中も維持する案: dispatch直前のrecord-first遷移が無ければ、crash位置を区別できない。
- 既存generation reservationだけで再送する案: reservation後・model結果後の両方に存在し、送信有無を証明しない。
- `dispatching`からmodel request callbackを再実行する案: providerが前回requestを受理済みなら二重model実行になる。
- result digestだけを保存してsemantic callback結果を作る案: SHA-256からno-advisory／proposal本文を復元できない。
- promptまたはraw provider outputをjournalへ保存する案: project evidenceと未検証model responseをObserver stateへ恒久複製する。
- host lifecycle journalへmodel statusを追加する案: generation rolloverとcycle requestのlock／cleanup／受入を再結合する。

## Acceptance

- model operation storeのexact schema、identity conflict、許可遷移、16 KiB canonical output、private path／lock、
  cleanupをfocused testで固定する。
- Supervisor fixtureでprepared／reserved crash、existing reservation＋journal欠損、dispatching unknown、accepted poll、
  completed再適用、appliedからprocessedへの所有権移管、planned rollover cleanupを固定する。
- provider別のexact result readとMailbox exact replayが未実装なら、それぞれをfake coreのgreenで完了扱いにしない。
- focused gateは`test/model-operation-store.test.mjs`と`test/supervisor-cycle.test.mjs`、関連gateは
  generation／cycle／Supervisorの既存testを一度実行する。
- full suite、live provider、network、credential、app UI、意図的障害試験は本TODOで実行しない。
