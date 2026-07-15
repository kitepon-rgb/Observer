# ADR 0055: provider固有のcycle resultをStop境界で束縛する

日付: 2026-07-15

## Status

Accepted for core implementation。provider固有journalとfake public-surface fixtureを先に実装する。
実host接続はblocking dependencyであり、本ADRのcoreだけでClaude／Codex exact result readを完了扱いにしない。
live hook設定／trust、Claude session相関、実model request、credential、network、app UIはH gateに残す。

## Context

[ADR 0050](0050-supervisor-model-operation-integration-contract.md)でSupervisorは、record-firstな
`issue_once`と同じoperationだけを読む`recover_only`へ分離された。しかしgeneric
`observer.model_operation.v1`はraw provider handleを持たないため、Claude／Codex固有のhandleとcycle結果を
別journalへ耐久化しなければ、`dispatching`回収を新しいmodel requestで代用する事故が残る。

当初案はCodex turnがterminalになった後の`thread/read`から結果を選ぶとしていたが、これは不成立である。
一つのCodex generationは一つのturnをStop continuationで複数cycleに使うため、cycle結果が必要な時点ではturnが
`inProgress`であり、terminal後には複数cycleのagent messageが同じturnへ蓄積する。Claudeも現行起動が
`--setting-sources ""`でhookを読み込まず、background jobの`sessionId`とStop payloadの`session_id`の同一性は
live実証されていない。fake fixtureだけで両host接続済みとは扱えない。

一方、Codex app-server 0.144.3の生成schemaでは`thread/read(includeTurns=true)`がin-progressを含むturnの
`id / status / items`を返し、AI本文は`type=agentMessage`の`id / text / phase`として保存される。Codex Stopは
`session_id + turn_id`、Claude Stopは`session_id + last_assistant_message`を持つ。したがってStopをcycle境界の
seal、provider surfaceを本文のcapture／再読面として組み合わせる。

## Decision

1. provider固有journalはtarget directoryの`provider-operations/`配下へ置き、CodexとClaudeで
   schema、file、lock、受入を分ける。generic model journal、host lifecycle journal、cycle pendingへ
   raw handleを複製しない。
2. 両journalはprovider、operation／target／generation ID、status、exact provider handle、
   raw-freeなprovider operation receipt digest、Stop seal、結果locatorまたはstrict parse済みcanonical result、
   timestampsだけを持つ。prompt、model input、tool log、credential、account表示を保存しない。
3. receipt digestはprovider、operation ID、generation ID、exact operation handleをdomain separationして
   算出する。結果取得前後で変えず、generic journalの`accepted` receiptとexact一致させる。
4. provider journal欠損、handle欠損、identity不一致は`provider_operation_missing`または
   `provider_result_unknown`とする。別thread、別turn、別job、別session、新しいmodel requestへfallbackしない。
5. Stop captureは同じoperationのresultをsealするrecord-only操作であり、continuationを発行しない。
   `stop_hook_active`はcapture可否に使わず、後続adapterがcontinuation再発行の抑止にだけ使う。

### Codex

6. Codex journal schemaは`observer.codex_model_operation.v1`とし、
   `thread_id + session_id + turn_id + after_item_id`をexact handleにする。`after_item_id`は直前cycleでseal済みの
   result item、最初のcycleだけnullとする。handleを`accepted`でatomic保存してからだけgeneric callbackへacceptedを返す。
7. Codex Stop sealは保存済みsession／turnとpayloadの`session_id / turn_id`をexact照合する。
   live Codex hook trustと、app-server `thread.sessionId`／Stop `session_id`の一致はhost接続TaskのH gateで固定する。
8. result readはStop seal後に、保存済みthreadだけへ`thread/read(includeTurns=true)`を一回発行する。
   turnが`inProgress`でも読む。`thread/start`、`turn/start`、`thread/resume`、interrupt、別thread探索を行わない。
9. 同じturnの`after_item_id`より後だけを候補にし、次のどちらかで一件に決まる時だけ採用する。
   - agentMessage総数が一件で、そのphaseが`final_answer`または欠損／null。
   - `phase=final_answer`が一件で、他のagentMessageがすべて明示`commentary`。
   候補0件、複数final、複数phase不明、baseline item欠損、未知shapeはfail closedにする。
10. 選択した`item_id`とstrict parse済みcanonical output digestをjournalへatomic保存するが、raw本文と
    canonical本文は保存しない。completed recoveryは同じthread／turn／itemを再読し、本文のstrict parseと
    digest一致を確認してからだけmemory内の`raw_output`を返す。item消失／変化を成功へ丸めない。

### Claude

11. Claude journal schemaは`observer.claude_model_operation.v1`とし、`job_id + session_id`をexact handleにする。
    `agents --json --all`で同じjob、session、cwd、nameを一件だけ相関できた時に`accepted`をatomic保存する。
12. Observer所有のStop captureだけが、保存済みsession IDとObserver cwdをexact照合し、
    `last_assistant_message`を`observer.ai_output.v1`としてstrict parseする。`stop_hook_active`がtrueでも
    matching operationはcaptureする。`StopFailure`、session不一致、missing message、invalid outputはcompletedにしない。
13. Claudeにはterminal後の公開exact result locatorが無いため、hook発火中にstrict parse済みcanonical output本体と
    digestをprovider journalへatomic保存する。raw hook payload、transcript path、`claude logs`本文は保存しない。
    これはgeneric completedへ移管するまでのbounded private handoffであり、16 KiB上限を維持する。
14. recoveryはjournalのcanonical outputを再検証し、canonical JSONを`raw_output`として返す。
    acceptedだがhook resultが無い場合はpendingまたはresult unknownで止め、`logs`、Claude private state、
    transcript直読、job respawn、新規requestへfallbackしない。
15. 現行`--setting-sources ""`を維持したままObserver所有hookだけを明示注入する隔離`--settings`入口、
    executable identity、project fingerprint不変をhost接続Taskで固定する。job `sessionId`とStop `session_id`の
    完全一致をClaude Code 2.1.210のlive H gateで実証するまで、productionのaccepted／completedへ昇格しない。
16. Stop payload受領後・atomic保存前のprocess deathは公開再読面がないため不可逆な
    `provider_result_unknown`／watch faultである。これをrecoverableと偽らず利用者へ報告する。

### handoff、cleanup、公開結果

17. provider completedを返した後、Supervisorはgeneric `completeModelOperation`を先に耐久化し、同じoperation、
    receipt、output digestをprovider cleanup APIがgeneric journalから再照合した後にprovider journalを削除する。
    順序は`completeModelOperation -> cleanupProviderOperation -> applyCycle`とする。
18. cleanup前crashはgeneric completedを正本として同じprovider cleanupを再実行する。cleanup後・apply前crashは
    generic completedからapplyを再開する。provider cleanupが失敗したままapplyやgeneric cleanupへ進まない。
19. provider APIの公開結果は`observer.model_operation_callback.v1`のaccepted／pending／completed／unknownだけとし、
    raw handle、item ID、session ID、canonical proposal本文を公開receiptへ含めない。

## Crash matrix

- generic `dispatching`後・provider journal前: operation missing。新規requestを送らずunknown。
- provider handle取得後・accepted保存前: handleを公開receiptへ出さずunknown。推測探索しない。
- accepted保存後・generic accepted前: provider journalから同じreceiptを回収する。
- Stop seal前: provider resultをcycleへ帰属させずpending。
- Codex Stop seal後・item locator保存前: 同じturnのbaseline以後を再読してexact候補だけを保存する。
- Codex locator保存後・generic completed前: 同じitemを再読しdigest一致後だけcompletedを返す。
- Claude Stop発火後・canonical保存前:不可逆unknown／fault。logs／transcriptで補わない。
- Claude canonical保存後・generic completed前: journalから同じcanonical outputを回収する。
- generic completed後・provider cleanup前: generic journalのreceipt／output digestでcleanupを再実行する。
- provider cleanup後・apply前: generic completedからmodel再実行なしでapplyする。

## Rejected alternatives

- Codex turnのterminal後だけ読む案: 一generation一turnの複数cycleを分離できない。
- Codex completed turnの最後の文字列を無条件採用する案: commentary、複数final、別cycleを混同する。
- Claudeを`claude logs`のterminal pollingへ揃える案: daemon消失後の公開回収を偽装する。
- Claude transcriptまたはprivate job stateを読む案: 公開契約外fallbackで、非同期transcript欠落も隠す。
- generic model journalへraw handle／raw outputを追加する案: host-neutral recoveryとprovider秘密を再結合する。
- provider journal欠損時に同じinputで再送する案: 前回request受理済みなら二重model実行になる。
- provider journalをapply後まで残す案: generic cleanup後のcrashで照合証拠を失い、孤児化する。

## Acceptance

- Codex focused fixtureでaccepted receipt、Stop seal、inProgress turnのbaseline以後exact item、phase不明の単一互換、
  明示commentary＋単一final、複数final／baseline欠損／handle mismatch、completed再読digest不一致、
  mutating request 0件を固定する。
- Claude focused fixtureでjob＋session相関、active true／false双方のStop exact capture、canonical durable recovery、
  StopFailure／session mismatch／invalid output、logs／private state／respawn 0件を固定する。
- provider journalは0700/0600、atomic create／replace、専用lock、identity conflict、receipt不変、
  generic completed前cleanup拒否を固定する。
- core完了後もTODOを閉じず、Observer所有hook注入、Codex item baseline、両host session／turn相関、
  Supervisor handoff順のhost接続Taskを続ける。
- TODO完了候補で両provider focused testを一度統合実行し、host runtime／Supervisorの関連gateを一度実行する。
- full suite、live model、live hook設定、network、credential、app UI、意図的障害試験は本core Taskで実行しない。
