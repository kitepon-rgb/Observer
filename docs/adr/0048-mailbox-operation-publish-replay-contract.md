# ADR 0048: model operationのMailbox publishを専用receiptでexact replayする

日付: 2026-07-15

## Status

Accepted for implementation。既存の手動／一般publish APIのduplicate拒否は維持し、
model operationからの適用だけに新しい冪等境界を追加する。

## Context

[ADR 0047](0047-model-operation-journal-contract.md)は、`completed`のcanonical AI outputを
model再実行なしで適用し、`applied`へexact cycle resultを保存する。advisoryの適用はMailboxへのpublishであるため、
inbox作成後・model journalの`applied`保存前にcrashすると、同じoperationを再適用しても二重配送せず、
同じpublish済み結果を回収できなければならない。

現行`publishMessage`はinbox／processing／failed／consumer receiptのいずれかに同じmessage IDがあれば
一律`E_MESSAGE_ID_DUPLICATE`にする。これは一般publishの再利用禁止として正しいが、同一operation・同一contentの
recoveryを成功として照合できない。またconsumer receiptは30日／1000件で削除されるため、これだけを
model operationの永続的なpublish証拠にはできない。

## Decision

1. 既存`publishMessage`の契約は変更しない。同じmessage IDは同内容でもduplicateとして拒否する。
   model operationは新しい`publishOperationMessage`だけを使い、一般publishの暗黙冪等化へ波及させない。
2. target Mailboxへ`publish-receipts/`を追加し、`observer.mailbox_publish_receipt.v1`を保存する。
   receiptはoperation ID、決定的message ID、target ID、content digest、`prepared | published`、
   created／updated timestampだけを持つ。message本文、proposal、raw model outputは複製しない。
3. message IDはmodel operation IDのhexから`obs-<64 lowercase hex>`として決定する。
   呼出側が別IDを渡した場合は拒否する。同じoperation IDは同じtarget／message ID／content digestにだけ束縛し、
   一つでも違えばconflictとしてfail closedにする。
4. `publishOperationMessage`は既存consumer lockの下で次のrecord-first順序を守る。
   1. matching receiptが無ければ`prepared` receiptをatomic createする。
   2. 同じmessage IDの所在をinbox、processing、consumer receiptから照合する。
   3. 所在が無ければ、呼出時に再供給されたstrict validation済みmessageをinboxへatomic createする。
   4. 所在のmessage／receiptが同じcontent digestを証明した時だけpublish receiptを`published`へatomic replaceする。
   5. `published` receiptのexact replayは新しいinboxを作らず、同じpublish結果を返す。
5. 同じIDで異なるcontent、target、operation、またはdigestを証明できない既存fileはconflictにする。
   malformed file、未知schema、digest欠損を「同じらしい」と推測しない。
6. crash recoveryは次のとおりとする。
   - receipt作成前: durable publishなし。同じoperationから通常開始できる。
   - `prepared`後・inbox前: 同じmessageを再供給してinboxを作る。
   - inbox後・`published`前: inboxのexact digestを照合し、本文を再作成せず`published`へ進める。
   - claim／本文削除後・`published`前: processingまたはconsumer receiptのexact digestを照合する。
   - `published`後・model journalの`applied`前: receiptから冪等成功を返し、二つ目のmessageを作らない。
7. `prepared` publish receiptが残る間、対応するconsumer receiptをretention cleanupで削除しない。
   inbox／processing本文が無くなった後も、publish済みか未publishかを曖昧にしないためである。
8. `cleanupOperationPublishReceipt`はmatching publish receiptが`published`で、呼出側がoperation ID、message ID、
   content digestをexact提示した場合だけ削除する。Supervisorはmodel journalを`applied`へdurable化した後にだけ呼ぶ。
   cleanup後の再適用禁止はmodel journalの`applied`が所有し、cycle processedへ移管する前にpublish receiptを消さない。
9. `no_advisory`はMailbox外部効果を持たない。決定的なno-op apply receiptからexact
   `observer.cycle_result.v1`を作り、架空のMailbox publish receiptを作らない。
10. publish receiptはconsumer delivery ackではない。`published`はMailboxへexact messageを一度公開したことだけを示し、
    親への注入成功やdeliveryを表現しない。

## Crash matrix

- publish receipt前: model journalは`completed`のまま。同じoperationから一度だけrecord-first publishを開始する。
- publish receipt `prepared`後: 同じmessage contentを再供給し、既存所在をexact照合する。
- inbox作成後: inboxを再作成せずreceiptを`published`へ進める。
- consumer claim後: processing本文またはconsumer receiptのdigestから同じpublishを回収する。
- delivery後: retained consumer receiptとpublish receiptを照合し、新規配送を作らない。
- model journal `applied`後・publish receipt cleanup前: applied resultを正本としてreceiptだけcleanupする。
- publish receipt cleanup後・cycle processed前: applied resultをpending cycleへ移管し、apply callbackを再実行しない。

## Rejected alternatives

- 現行`publishMessage`を同内容なら常に成功へ変える案: 一般publisherのmessage ID再利用禁止を弱め、
  operation ownershipの無いcallerまで暗黙冪等にする。
- consumer receiptだけをpublish証拠にする案: retention cleanup後に同じIDを再公開でき、長時間crash recoveryを証明しない。
- inbox作成後にだけpublish receiptを初めて作る案: その間のcrashで、消費済みmessageと未publishを区別できない。
- publish receiptだけを先に`published`にする案: inbox作成前crashを成功扱いし、実際にはmessageが存在しない。
- publish receiptへmessage本文を保存する案: Mailbox本文を別stateへ複製し、配送後本文削除の契約を破る。
- duplicate errorをcatchして成功扱いする案: 同一content、異内容、malformed、過去receiptを区別しないfallbackになる。

## Acceptance

- focused fixtureでrecord-first順序、同内容replay、異内容conflict、inbox／processing／consumer receiptからの回収、
  `prepared`対応receiptのretention保護、applied前cleanup拒否を固定する。
- 既存`publishMessage`のduplicate拒否testを維持する。
- Supervisor fixtureでadvisory apply後crash、`completed` recovery、`applied` recovery、no-advisory no-opを固定する。
- live parent hook、network、credential、app UI、意図的障害試験は本TODOでは実行しない。
