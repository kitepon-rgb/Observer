# ADR 0038: generation host rolloverをwatch継続transactionとして固定する

日付: 2026-07-15

## Status

Accepted for implementation。fake hostによるcore／adapter検証を先行し、live Claude／Codex受入はH gateに残す。

## Context

[ADR 0034](0034-generation-budget-and-planned-rollover.md)と
[ADR 0037](0037-cycle-generation-exact-once-acceptance.md)により、budget到達時は旧generationでmodelを呼ばず
`rollover_requested`へ止められる。しかし既存の`requestParentStop`／`completeParentStop`はwatchそのものを
`stopping → stopped`へ閉じるため、同じwatch認可を維持するplanned rolloverへ流用できない。

また、Codex host journalはwatch単位の一ファイルで二回目のthread startを拒否し、Claudeの同名job recoveryは
`--all`に過去のterminal jobが残ると一意性を失い得る。generation stateは意図的にraw provider handleを保存しないが、
stop／spawn recoveryにはprivateな旧／新handle相関が必要である。

## Decision

1. planned rolloverはwatchを`active`のまま維持する。`requestParentStop`、`completeParentStop`、新watch予約を呼ばず、
   watch ID、provider、target、canonical Observer rootを変更しない。
2. Observer private stateに短命な`observer.generation_host_rollover.v1` journalを置く。generation stateがlifecycleと
   budgetの正本、journalはhost commandのexact-once相関だけを所有する。provider管理dirや監視対象repoへ置かない。
3. journalは次のexact fieldを持つ。
   - identity: `schema`、`watch_id`、`target_id`、`provider`、`from_generation_id`、`from_sequence`
   - next identity: `to_generation_id`、`to_sequence`
   - operation: `status`、`previous_handle`、`next_handle`
   - receipts: `stop_command_receipt_digest`、`terminal_receipt_digest`、`spawn_receipt_digest`、`ready_receipt_digest`
   - time: `created_at`、`updated_at`
4. `status`は`stop_authorized → terminal_observed → spawn_authorized → spawn_observed → ready_observed`の単調遷移とする。
   raw handleはこのprivate journalとactive watch stateだけに保存でき、generation state、public result、log、receipt digest以外の
   durable memoryへ複製しない。`ready_observed`後にgeneration activationを確認してjournalを削除する。
5. `prepareGenerationHostStop`はactive watchのprivate handle、`rollover_requested` generation、既存journalを照合し、
   journalをstop commandより先に耐久化してgenerationを`stopping`へ進める。初回だけ`issue_once`、再開時は
   `observe_only`を返し、command結果不明を再送しない。返すstop requestは既存host runtimeが検証できる
   `observer.parent_stop_request.v1`だが、watch stateは変更しない。
6. terminal ACK、timeout、command successだけでは進めない。Claudeは同じjobのterminal observation、Codexは同じ
   thread／turnの`completed | interrupted | failed`を含む`stopped` host receiptを要求し、
   `confirmGenerationTerminal`成功後だけjournalを`terminal_observed`へ進める。
7. `authorizeNextGenerationHostStart`はterminal confirmedから`beginNextGeneration`を行い、新generation ID／sequenceを
   journalへ固定してから初回だけ`issue_once`を返す。再開時は`recover_only`とし、spawnを推測再送しない。
8. provider spawn receiptはjournalへ新handleを先に保存し、その後active watchのprivate handleを旧→新へCAS交換する。
   crash後はjournalとwatchのどちらまで進んだかを照合して不足分だけ適用し、第三のhandleを上書きしない。
9. ready receiptはjournal、watch binding、starting generationのprovider／watch／target／handleをすべて照合し、
   `activateGeneration`成功後にだけjournalを削除する。旧terminal未確認、spawn結果不明、handle競合では新generationを
   activeへ丸めない。
10. Codex provider journalはgeneration IDでnamespaceし、旧terminal journalを上書きしない。Claude recoveryは同じ
    deterministic name／cwdのうちliveな`working | blocked`候補だけを新spawn候補にし、複数live候補はfail closedにする。
    過去terminal jobを新しいreadyへ再利用しない。
11. 一連の公開coreはhost command自体を実行せず、`issue_once`／`observe_only`／`recover_only`と検証済みrequest/contextを
    返すrecord-first境界にする。Claude／Codex runtime呼出しは上位bindingが行い、unknown後の暗黙fallbackを禁止する。

## Crash matrix

- journal作成後・stop command前: `observe_only`で止まり、同じstopを自動再送しない。
- stop command後・terminal前: 同じhandleのterminalだけを再観測する。
- terminal state後・journal更新前: terminal receipt再適用でjournalだけ進める。
- next generation開始後・spawn前: `recover_only`。provider journal／agent listで回収し、推測再spawnしない。
- spawn receipt後・watch handle交換前: journalのnext handleから旧→新CASだけを再開する。
- watch handle交換後・generation activation前: 同じnew handleのreadyだけでactivationを再開する。
- activation後・journal削除前: activationの冪等照合後にjournalだけ削除する。

## Rejected alternatives

- watch stop／新watch startとして扱う案: 利用者の一回の明示認可と一parent一論理Observerを破る。
- generation stateへraw handleを追加する案: budget／lifecycle正本とprovider operation秘密を再結合する。
- stop／spawnをreceipt保存前に直接呼ぶ案: crash後の重複commandを防げない。
- Codexの旧journalを上書きする案: 旧／新generationのterminal相関とunknown recoveryを失う。
- Claudeのterminal履歴をname一致だけで再利用する案: 過去jobを新generationとして誤認する。

## Remaining gates

- 本ADRのjournal、watch handle CAS、Codex generation journal、Claude live-candidate recoveryのfake fixture実装。
- provider別bindingとmodel operation journal。
- live Claude／Codexでのstop、spawn recovery、単一Observer project表示のH受入。

