# ADR 0050: Supervisorをissue・recover・apply・finalizeの四境界へ分ける

日付: 2026-07-15

## Status

Accepted for implementation。host-neutral callback fixtureだけを本Taskで受け入れ、provider固有result readと
実Mailbox applyは別Task／H gateに残す。

## Context

[ADR 0047](0047-model-operation-journal-contract.md)と[ADR 0049](0049-model-operation-store-core-acceptance.md)により、
model operationは`prepared -> reserved -> dispatching -> accepted -> completed -> applied`をdurableに保持できる。
しかし現行`runSupervisorCycle`はgeneration reservation後に一つの`processCycle` callbackを呼び、既存reservationを
一律`model_result_unknown`にする。新規送信、exact operation回収、canonical output適用が同じcallbackに混在し、
crash recoveryで何を再実行できるかを表現できない。

## Decision

1. `runSupervisorCycle`の`processCycle`を、次の四つの必須callbackへ置き換える。
   - `issueModelOperation`: `dispatching`をdurable化した直後に一度だけ呼ぶ。
   - `recoverModelOperation`: durable `dispatching | accepted`から同じoperationだけを照合する。
   - `applyCycle`: durable `completed`のcanonical AI outputを、operation IDをdedupe identityとして冪等適用する。
   - `finalizeAppliedCycle`: durable `applied`の外部冪等receiptを、同じoperationだけについて冪等cleanupする。
2. issue／recover callbackへ渡すoperation receiptは、schema、action、provider、operation／target／watch／generation／cycle ID、
   input digest、model-visible bytes、status、provider operation receipt digestだけを持つ。raw handle、prompt、turn、
   provider output、tool log、completed／applied本文は含めない。
   `issueModelOperation`だけが非永続`value`を別fieldで受け、`recoverModelOperation`のinputには`value` field自体を作らない。
   `finalizeAppliedCycle`のreceiptだけはexact `observer.cycle_result.v1`とcompleted output digestを追加し、
   Mailbox receipt等の外部dedupe証拠を本文なしで照合できるようにする。
3. callback resultはstrict `observer.model_operation_callback.v1`一件とし、未知fieldを拒否する。
   - `accepted`: `{schema,outcome:"accepted",provider_operation_receipt_digest}`。provider固有journalへexact handleを
     耐久化した証拠digestであり、generic journalを`accepted`へ進める。
   - `pending`: `{schema,outcome:"pending"}`。durable `accepted`からだけ許し、journalを変更しない。
   - `completed`: `{schema,outcome:"completed",provider_operation_receipt_digest,raw_output}`。provider固有journalへ
     exact result locatorを先に耐久化したdigestが必須で、Supervisorはgeneric journalを`accepted`へ進めた後にだけ
     raw outputをmemory内でstoreのstrict parserへ渡す。callback return後にraw outputを保存・公開しない。
   - `unknown`: `{schema,outcome:"unknown",reason}`。reasonは
     `provider_operation_missing | provider_result_unknown | provider_unavailable`のenumとし、journalを後退・削除せず
     `model_result_unknown`を返す。
4. `dispatching`から`pending`を返すことを拒否する。exact provider receipt無しの「実行中」はacceptedを証明しない。
   `accepted`からはmatching `accepted`、`pending`、`completed`、`unknown`を許す。
5. Supervisorはinput構築後にcurrent generationをexact照合し、generation reservationより先に
   `prepareModelOperation`を呼ぶ。new pending cycleまたは既存pending＋journal有りだけを通常経路へ進める。
6. 既存prepared pendingでmodel journalが無い時は、generationのmatching pending reservationを先に調べる。
   reservationが有ればcutover前／journal消失を未送信と推測せず`model_result_unknown`で止める。
   reservationが無い時だけ新しい`prepared` journalを作れる。別reservationは既存generation契約どおりconflictにする。
7. `prepared | reserved`はmatching reservationを作成／確認し、storeが`issue_once`を返した時だけ
   `dispatchModelOperation`をrecord-first実行してからissue callbackを呼ぶ。planned rolloverでは未送信`prepared`を
   cleanupし、pending cycleを残したまま`rollover_required`を返す。
   generationがすでに`rollover_requested | stopping | terminal_confirmed`へ進んだcrash recoveryでも、
   matching未送信preparedとreservation nullをexact照合して同じcleanupへ戻る。
8. `dispatching | accepted`はissue callbackを呼ばずrecover callbackだけを呼ぶ。callback throw、timeout、connection lossを
   新規送信へfallbackせず、journalをそのstatusに残してerrorを伝播する。
9. `completed`はmodel callbackを呼ばず`applyCycle`へcanonical output本体とraw-free operation receiptを渡す。
   exact `observer.cycle_result.v1`を得た後にstoreを`applied`へ進める。apply throw時は`completed`を残し、次回同じ
   operation IDでexact replayする。
10. `applied`はapply callbackを再実行せず、先に`finalizeAppliedCycle`を呼ぶ。callbackはraw-free applied operation receiptを受け、
    Mailbox publish receipt等の外部dedupe証拠をexact cleanupする。すでにcleanup済みなら冪等成功し、throw時はjournalを
    `applied`に残す。`no_advisory`は外部receiptを作らないno-op finalizationとして成功する。
11. finalize成功後、保存済みexact cycle resultで`markCycleProcessed`を行う。順序は
    `finalizeAppliedCycle -> markCycleProcessed -> cleanupAppliedModelOperation -> commitProcessedCycle`とする。
    model store自身もmatching processed pendingを照合し、call-siteだけに順序不変条件を委ねない。
12. 起動時にpending cycleが既に`processed`なら、model journalを読む。matching `applied`が残る場合は
    `finalizeAppliedCycle`を冪等再実行してからjournalをcleanupし、
    それ以外のstatus／identity／result不一致を成功扱いしない。journalが無ければprocessed pendingを正本として既存commitを再開する。
13. callback公開receiptとSupervisor returnへraw output／canonical proposal本文を含めない。return statusは既存
    `timeout | rollover_required | model_result_unknown | committed`に`model_pending`を追加する。
14. model operation lock残留は時刻で自動破棄しない。storeのinspect surfaceでowner／nonceを公開し、owner process終了を
    外部確認した運用層だけがexpected nonce付きrecoverを行ってから同じSupervisor cycleを再開する。

## Callback transition matrix

| durable status | callback | 許可outcome | 次の処理 |
|---|---|---|---|
| fresh `dispatching` | issue | accepted | journal accepted、`model_pending` |
| fresh `dispatching` | issue | completed＋receipt | journal accepted→completed、applyへ進む |
| fresh `dispatching` | issue | unknown | dispatchingを保持、`model_result_unknown` |
| recovered `dispatching` | recover | accepted | journal accepted、`model_pending` |
| recovered `dispatching` | recover | completed＋receipt | journal accepted→completed、applyへ進む |
| recovered `dispatching` | recover | unknown | dispatchingを保持、`model_result_unknown` |
| `accepted` | recover | accepted／pending | exact receipt照合後、`model_pending` |
| `accepted` | recover | completed＋matching receipt | journal completed、applyへ進む |
| `accepted` | recover | unknown | acceptedを保持、`model_result_unknown` |
| `completed` | なし | — | idempotent applyだけ |
| `applied` | finalize | exact cleanup／no-op | processed移管へ進む |

## Rejected alternatives

- 一つの`processCycle` callbackへactionを足す案: issueとrecoverで非永続`value`の有無、再送可否、return schemaが異なり、
  callerの誤再送を型／fixtureで分離できない。
- `dispatching` recoveryへinput valueを再供給する案: provider handle欠損時に新規requestへ使えてしまう。
- callback throwを`unknown`へ丸める案: provider defectと明示unknownを区別できず、診断を失う。
- apply callback内で外部receiptまでcleanupする案: model journalを`applied`へ耐久化する前にdedupe証拠を失い、
  crash後のexact replayを証明できない。
- 既存reservation＋journal欠損へ新しいpreparedを補う案: cutover前reservationを未送信と誤認して二重model実行しうる。
- `applied` cleanupをcycle processedより先に行う案: crash後にcycle resultの正本を失う。
- processed pendingがあれば任意statusのjournalを削除する案: 未適用operationを成功として握りつぶす。

## Acceptance

- focused fixtureで新規issue、dispatching／accepted recovery、receipt必須completed、completed apply、apply後crash、applied finalize、processed移管、
  processed後cleanup、journal欠損＋既存reservation、planned rollover cleanup、callback throwを固定する。
- 残留model lockはwrong nonceを拒否し、owner終了をfixtureで証明した明示recover後だけ同statusから再開する。
- issue callbackだけが`value`を受け、recover callbackに`value`が無いことをfixtureで確認する。
- callback resultのunknown field、dispatching pending、invalid digest／raw outputをfail closedにする。
- related generation／cycle／Supervisor gateはTODO完了候補で一度だけ実行する。full suiteとlive providerは実行しない。
