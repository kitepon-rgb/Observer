# Observer v1 製品契約

**Status:** Canonical

**作成日:** 2026-07-14

**対象:** Observer v1

---

## 1. 目的

Observerは、指定されたプロジェクトで動く親AIを外部から継続観測し、親の成果を有意に改善できる時だけ、証拠付きの助言を届ける。

Observerは第二の親ではない。

- 親が設計、実装、テスト、統合、最終裁定を行う。
- Observerは親の確定ターンとプロジェクト状態を観測する。
- Observerは助言とソフトストップだけを行う。
- Observerは親の仕事を代行せず、指揮権を奪わない。
- 問題がなければ沈黙する。
- Observerは親と同じprovider familyで動き、近い思考様式と同じアプリのUXを保つ伴走者である。
- Observerは毎turnへ反証を打ち込む監査官ではない。独立反証やPhase監査は別役割が担う。
- Observerは利用者の明示指示を受けた親だけが起動し、暗黙には起動しない。

---

## 2. システム境界

```text
Throughline
  = session、turn、完了証拠、handoff、completed-turn read / wait CLI契約の所有者

Observer
  = project追跡、cursor、監査、dedupe、Mailbox、AI向けMCP adapterの所有者

Observer host adapter
  = Claude／Codex固有の完了証拠、project-local継続、親Mailbox配送wireを共通coreへ変換する

Observer project-local Stop hook
  = 監視中だけ同じhost turnを次の監視サイクルへ継続する

親host Stop hook adapter
  = 自分宛ての手紙を短時間で取得し、host固有のadvisory promptとして一度だけ返す配送員

親Claude／Codex
  = 設計、実装、助言の採否、最終裁定の所有者
```

ThroughlineはObserver stateや手紙本文を所有しない。ObserverはThroughlineのDB stateを複製または変更しない。

### 2.1 Observerプロジェクトidentity

製品として起動するClaude／Codex Observerのhost `cwd`は、監視対象にかかわらずcanonicalなObserver
リポジトリrootへ固定する。監視対象の絶対`project_root`はtarget ID、child start envelope、Observer MCPの
照合データであり、host `cwd`、一時git repo、アプリ上の別projectへ変換しない。

複数targetはwatchごとにthread／jobを分離してよいが、実行projectは一つのObserverである。これにより
Observer rootの`AGENTS.md`／`CLAUDE.md`を静的な製品役割の正本とし、起動promptにはwatch identity、cursor、
観測入力など可変情報だけを渡す。実行時役割は検証済み`observer.child_start.v1`かつ`mode=observe`の時だけ
有効にし、同じrepoを編集する開発AIの権限と混同しない。

Codexアプリ／Claude UI上で単一Observer projectとして表示されることはlive hostのH受入条件である。
requestの`cwd`固定、persistent stateの列挙、`source` fieldだけでUI表示済みとは判定しない。

---

## 3. 監視対象

利用者がObserverへ指定する必須入力は、監視したいプロジェクトの絶対パスだけとする。

```bash
observer watch /absolute/path/to/project
```

- 固定の親session IDやControl IDを利用者へ設定させない。
- Throughline上で指定フォルダに属し、最後の確定ターン更新が最新の適格スレッドを現在の親として追う。
- 親スレッドを作り直した場合、新しいスレッドの確定ターンが最新になった時点で同じwatchを正式にrebindする。
- 一つの親session epoch（providerとthread digestで識別）には、一つの論理Observerだけを対応させる。
  旧epochと新epochの論理Observerを同時にactiveにしない。
- v1は、一プロジェクトにつき同時に活動する親は一つと仮定する。
- v1の監視対象hostはClaudeとCodexとする。
- Observerのmodel providerは現在親のhostと一致させる。Codex親にはCodex、Claude親にはClaudeを使う。
- 同じprojectで適格なClaude親とCodex親が同時に活動し一意に解決できない場合はfail closedとし、残レートや推測で選ばない。
- 同時に複数親が活動する場合の競合解決はv1の契約外とする。

DBファイル自体のmtime、`sessions.updated_at`、`bodies`の件数を親選択へ使わない。Codexはrolloutの`task_complete`、ClaudeはPhase 0で実hostから確定した完了証拠だけを使い、Throughlineが返すhost-bound cursorと完了時刻から現在親を解決する。

### 3.1 起動と停止

- 利用者が現在の親へ明示的に起動を依頼した時だけ、親がObserverを起動する。
- Codex親はCodex Observer、Claude親はClaude Observerを各hostの正式なbackground／child入口から起動する。
- install、SessionStart、project open、Throughline更新を契機に自動起動しない。
- 親はprovider childを起動する前に、Observer所有stateへproject target単位のactive watchを確保する。
- 一targetでactive watchは一つだけとし、二重起動は`already_active`でfail closedにする。後勝ちtakeoverしない。
- 親threadが再作成された時は、旧論理Observerの物理host generationをterminalへ閉じてから、同じwatch上で
  新parent epoch用の論理Observerへrebindする。新しいwatchを追加せず、旧／新Observerを並走させない。
- 一つの論理Observerは一つ以上の物理host generationを持てる。context budget到達時は同じparent epochのまま
  世代交代し、同時にactiveなClaude job／Codex threadは一つだけとする。
- generation間で引き継ぐのはObserver所有のcursor、dedupe／cooldown receipt、boundedな未解決仮説だけとし、
  raw会話履歴、prompt全文、tool logをdurable memoryとして保存しない。
- parent rebindと計画的context rolloverは、最初の利用者明示起動で許可されたwatch lifecycleの継続であり、
  fault／crash後の無断自動再起動とは分離する。旧generationのterminalを確認できない場合は新世代を起動せずfaultにする。
- 利用者が親へ明示的に停止を依頼した時は、親がchildを停止してactive watchを閉じる。
- fault時は継続と自動再起動を止め、親が原因を利用者へ報告する。

Codex hostはpersistent app-server threadを使い、thread IDをwatchのprivate provider handle、active turn IDを
Observer所有のdurable operation journalへ分離して保存する。`thread/start`または`turn/start`の結果が不明な時は、
同じObserver `cwd`に見えるthreadやturnを推測でattachせず、`*_start_unknown`を保持して再実行を止める。
`thread/read`は保存済みIDのterminal照合、`thread/resume`は再接続後の継続とevent購読にだけ使う。

Codex停止では`turn/interrupt`の空ACKを終端証拠にしない。同じthread ID／turn IDの
`completed | interrupted | failed`観測をCodex固有terminal receiptへ束縛し、そのreceiptをparent launch coreが
検証した後だけwatchを閉じる。app-server process／connectionは再作成可能なtransportであり、provider handleにしない。
thread／turnの`cwd`は常にcanonical Observer rootで、target `project_root`はchild envelopeにだけ保持する。

各cycleのmodel結果はhost lifecycleと別のprovider operation journalで回収する。CodexはcycleごとのStopを
session／turnへsealし、保存済みthread／turnの`thread/read(includeTurns=true)`から直前cycleのresult item以後にある
exactな`agentMessage` itemだけを再読する。Claudeはbackground job IDとsession IDを束縛し、Observer所有`Stop` hookの
`last_assistant_message`を発火中にstrict parseしてcanonical outputをatomic保存する。`stop_hook_active`は
result captureを抑止せず、continuation再発行の制御だけに使う。Claude terminal後の
`logs`、transcript、private provider state、handle欠損時の別turn／別job／新規requestをfallbackに使わない。
provider journalが欠ける場合は結果不明のまま止め、二重model実行を避ける。
provider completedはgeneric model operationへcanonical outputを耐久化した後、raw outputを含まない
`cleanup_only` receiptでprovider journalをcleanupし、exactな
`observer.model_operation_cleanup.v1 / cleaned`を確認してからだけcycle applyへ進む。
順序は`completeModelOperation -> cleanupProviderOperation -> applyCycle`とし、cleanup失敗を
apply成功へ丸めない。generic completedからのrecoveryでも同じcleanupを再実行する。

親の明示起動契約は[ADR 0002](adr/0002-explicit-parent-launch.md)、Codex hostの耐久境界は
[ADR 0018](adr/0018-codex-host-runtime-boundary.md)を正本とする。

---

## 4. Throughline待機契約

Throughlineは、turn本文を返さないread-only long-poll CLIと、完了turnを取得するread CLIを提供する。Observer所有のMCP adapterはこの二入口を子processとして呼び、AIへ同名のread-only toolとして公開する。ObserverはDB / WALを直接読まない。

```text
wait_for_turn_change(
  project_root,
  after_cursor,
  timeout_seconds = 3600
)
```

### changed

呼出時点ですでに新規確定turnがある場合、または待機中に親のDoneで確定turnが追加された場合:

```json
{
  "schema": "throughline.observer_wait.v1",
  "status": "changed",
  "afterCursor": "tlc1:...",
  "throughCursor": "tlc1:..."
}
```

### timeout

一時間更新がない場合:

```json
{
  "schema": "throughline.observer_wait.v1",
  "status": "timeout",
  "afterCursor": "tlc1:...",
  "throughCursor": "tlc1:..."
}
```

### 保証

- cursorはThroughlineだけが解釈するopaque tokenとし、Observerは比較、加工、採番せずそのまま保存して返す。
- 一回の待機上限は既定3600秒。各host側のtool timeoutは待機上限より余裕を持たせ、実hostで60秒超の保持を検証する。
- Observer MCPのwait / read toolはread-only注釈を持ち、Observer設定は公開toolをこの二つへallowlistしたうえで各toolだけを非対話実行へ明示許可する。
- changed応答へturn本文を含めない。
- Observerはchanged後、`read_completed_turns(project_root, after_cursor, through_cursor)`相当の入口から完了turnを取得する。
- read入口は初回の`snapshot`、通常の`delta`、親作り直しの`thread_switched`、rollback等の`resync_required`、DB freshness待ちの`projection_pending`を区別する。
- snapshotは過去履歴のbounded orientationであり、truncationを明示する。監視開始後のdelta / thread switchはopaque page tokenで全件を回収し、bounded上限による欠落を成功扱いしない。
- Observerはreadと監査が正常終了した後だけ保存cursorを進める。read失敗時は旧cursorを保持する。
- 通知の重複とspurious wakeupは許容する。
- 呼出、waiter登録、timeout、再接続の境界で確定turnを失ってはならない。
- ObserverはThroughlineのDB、WAL、mtimeを直接監視しない。
- Codexではrolloutの`task_complete`を完了証拠とする。進行中turnを含みうる現行DB projectionだけではchangedにしない。
- Claudeではtranscript、hook、Throughline projectionのうちPhase 0で実証した完了境界だけを採用する。Codexの`task_complete`相当を推測で作らない。
- Throughlineは完了証拠から最新threadを解決し、既存`auditor-context`相当のfreshness照合を通した本文だけをread結果にする。

Throughline wait processは短い間隔で自身のrollout / DB projectionを再確認してよい。pollingは公開契約へ漏らさず、各DB read transactionを短く閉じる。Observer runtimeのAI向けtransportはMCP、Throughlineとのprocess境界はJSON-only CLIとする。

---

## 5. Observer監視turn

```text
保存cursorからMCPで最大一時間wait
  ├─ changed
  │    └─ turn取得 → 監査 → 必要なら手紙 → Observer Done
  └─ timeout
       └─ 待機継続を報告 → Observer Done

Observer project-local Stop hook
  └─ host固有のbounded continuationで同じhost turnを次の監視サイクルへ継続
       └─ 保存cursorから再び最大一時間wait
```

timeout時の定型文:

```text
親スレッドの更新がありませんでした。待機します。
```

- timeout報告はObserver自身のスレッドだけへ出す。
- timeoutを親のMailboxへ送らない。
- timeout時はAI意味監査とproject走査を行わない。
- Observer Done後、Stop hookは`{"decision":"block","reason":"監視を継続する"}`相当のbounded promptを返す。
- この再開は新しいuser turnではなく、同じhost turn内の次の監視サイクルである。Claude／Codexそれぞれでこの性質を実測する。
- Stop hook自体はlong-pollしない。
- timeoutと次のwaitの間にturnが増えた場合、同じcursorによる次回呼出しで即時回収する。
- crash後は保存cursorから再開する。
- 明示停止またはuser interrupt時は継続しない。通常の`stop_hook_active=true`だけを理由に監視を終了せず、Observer所有のactive watch stateで継続可否を決める。
- Stop continuationを許可するcycle結果は、`changed`のread / 監査完了と正常`timeout`だけとする。
- MCP、Throughline CLI、schema検証、cursor保存の失敗時はwatch stateを`faulted`にし、Stop hookはblockを返さない。壊れた状態で高速な自己再開を繰り返さない。
- `projection_pending`の短い再試行はObserver MCP adapter内部でboundedに行い、AI cycleを増やさない。上限後もfreshにならなければfaultとして表面化する。

---

## 6. Observerの権限

Observerが読めるもの:

- 対象親のThroughline確定turn
- `AGENTS.md`、承認済みplan、TODO、Phase
- ソース、テスト、git diff / status / log
- Control Record、Run、既存test evidence

Observerが書けるもの:

- Observer自身のproject target、cursor、dedupe、cooldown state
- Observer所有の中央Mailbox

Observerが行ってはならないもの:

- 監視対象のコード、テスト、文書、設定の編集
- Task、Run、Control Record、planの変更
- Workerまたは別AIの起動
- 実装、修正、stage、commit、revert、cancel、interrupt、push、deploy
- H承認の代行
- 親の技術的停止
- Mailbox以外から親への助言注入

この境界はpromptだけでなく、実行権限と拒否testで強制する。

---

## 7. 助言契約

各観測サイクルの既定結果は`no_advisory`とする。

Observer AIのhost非依存出力は`observer.ai_output.v1`のJSON object一件だけとする。正常進行では理由や
通常会話を付けず、次のexact objectを返す。

```json
{"schema":"observer.ai_output.v1","outcome":"no_advisory"}
```

助言候補は一件だけとし、次のexact fieldを持つ。Markdown、code fence、前後の説明、配列による複数候補、
provider／target／watch／cycleの自己申告を許さない。それらの相関はSupervisorが信頼済みcontextから束縛する。

```json
{
  "schema": "observer.ai_output.v1",
  "outcome": "advisory",
  "proposal": {
    "body": "放置した場合の実質的な影響",
    "category": "verification_gap",
    "dedupe_key": "verification:focused-gate",
    "evidence_refs": ["test:focused-gate-missing"],
    "severity": "warning",
    "suggested_action": "親が検討できる一つの行動",
    "title": "具体的なclaim"
  }
}
```

- severityは`info`、`warning`、`review_required`だけを許す。
- categoryは`stagnation`、`scope_drift`、`repeated_failure`、`verification_gap`、`unknown_run`、
  `plan_drift`、`overengineering`、`acceptance_mismatch`、`context_drift`だけを許す。
- raw出力は16 KiB以下、evidenceは1〜16件とし、文字列fieldはMailbox message以下のbyte上限へ揃える。
- digestはschema検証・固定順正規化後にSupervisor側で計算し、AIが返したdigestを信用しない。

AIへ一cycleで渡すhost非依存evidenceは`observer.evidence_snapshot.v1`へ固定し、canonical JSONのUTF-8で
32 KiB以下とする。snapshotは一時入力であり、raw JSONや本文をdurable stateへ保存しない。

- 信頼済みcycle contextはtarget、watch、parent host／thread digest、cycle ID、cursor digestを持つ。
  opaque cursor本文、raw parent session ID、targetの絶対pathをAI自己申告またはevidence refへ複製しない。
- `turns`、`plan`、`git`、`tests`を別sectionにし、各entryへstable ref、source digest、truncated／redacted／availableを持たせる。
- Throughline turnは最新側から最大12 KiB、承認済みplanは最大4 refs／6 KiB、git status／diff evidenceは8 KiB、
  test receiptは最大16件／4 KiBを上限とし、snapshot全体32 KiBを最終hard gateにする。
- secret patternは固定markerへ置換して`redacted=true`とする。元secret、元secretだけのdigest、raw prompt、
  full patch、巨大logをsnapshot receiptへ保存しない。
- omission、upstream truncation、redaction、collector unavailableを明示し、advisoryは`available=true`かつ
  非truncated／非redactedなrefだけを根拠にできる。不足を完全な証拠へ丸めない。
- durable receiptはsnapshotのcanonical digest、serialized bytes、section件数、truncation／redaction flags、
  相関IDだけを保存する。

一つの物理host generationは最大8 completed observation cycle、かつObserver所有のmodel-visible payload累積
256 KiB未満に制限する。protocol prompt、MCP response、evidence snapshot、AI outputのserialized bytesを数え、
次のcycleで上限へ達する場合は開始前にplanned rolloverする。provider非公開token量の推測をhard gateにしない。

手紙には次の全てが必要。

1. 具体的なclaim
2. 確認可能なbounded evidence
3. 放置した場合の実質的な影響
4. 親が検討できる一つのsuggested action
5. 最近の手紙と重複しない新規性
6. 今伝える価値がある適時性

severity:

```text
info
  今伝える価値のある非自明な助言。停止不要。

warning
  継続すると目的、scope、品質、検証へ悪影響が出る可能性が高い。

review_required
  次の変更へ進む前に証拠確認を要請するソフトストップ。
  親を技術的に停止しない。
```

送らないもの:

- 単なる好み、別解、一般論、励まし
- 証拠のない推測
- 親が認識し、具体的に対処中の問題
- cooldown中の同一指摘
- 親の成果を有意に改善しない軽微な最適化

一観測サイクルの手紙は最大一件とする。

---

## 8. Observer state保存契約

v1のsupported platformはmacOSとする。

```text
~/Library/Application Support/Observer/
  targets/
  watches/
  mailboxes/
```

- target IDはcanonical project pathから導くdigestとし、path文字列をdirectory名へ直接使わない。
- directoryは`0700`、state / message / receiptは`0600`を要求する。
- temp fileは必ず最終fileと同じdirectory / filesystemへ作り、検証後にatomic renameする。
- symlink、owner不一致、group / other permission、相対path、path traversalをfail closedで拒否する。
- working tree、Throughline、Claude、Codexの管理領域へObserver stateを書かない。
- test用の明示state rootは許可するが、通常利用者の必須入力はproject絶対pathだけとする。
- Linux / Windowsはowner、mode、atomicity、installerを実証するまで`unsupported`または`unverified`と表示し、自動fallbackしない。

---

## 9. Mailbox配送契約

MailboxはObserver所有の中央状態領域へ置き、working tree、Throughline、Claude、Codexの管理領域へ置かない。

- project targetごとにinboxを物理分離する。
- 手紙にはproject targetと観測元`thread_sha256`を持たせ、raw thread IDを保存しない。
- 親Stop hookはpayloadのraw thread IDをその場でSHA-256化し、registered target、active watch provider、
  committed parentのhost／thread hashと一致する手紙だけをclaimする。
- 旧thread向けの手紙を新threadへ付け替えない。
- 旧指摘が有効なら新thread上で再評価し、新message IDを発行する。
- 別project、旧thread、target不明、target複数一致ではfail closedとする。
- authoritative current hookだけが、同targetの旧thread messageを本文なし`stale_thread` receiptへ失効できる。
  publish、current routeの再検証、stale処理、claimは同じtarget Mailbox lockへ線形化する。

配送意味論:

```text
at-most-once advisory delivery
```

- atomic claim後は同じmessage IDを再配送しない。
- 正常配送後は本文を削除する。
- claim後の不明終了は`delivery_unknown`とし、同じ本文を再配送しない。
- 正常receiptのresultは`emitted_unacked`とする。Hook JSONのstdout書込が完了し、local finalizeが成功して
  hook processが正常終了へ進める状態になったことだけを表す。Hostがstdoutを読んだこと、親contextへ採用したこと、
  continuationが実行されたことのackは偽装しない。
- Host ackが存在しないv1では`delivered`というresult名を使わない。
- receiptには本文を含めず、boundedなdigestと配送metadataだけを残す。
- 完了receiptの既定retentionは30日かつ最大1000件とし、古いものから削除する。未完了の`claimed` receiptは件数・日数cleanupで自動削除せず、明示recoveryの対象とする。
- consumer lockはowner nonceを持つ。残留lockは観測したnonceを指定する明示recoveryだけで削除し、時刻だけを根拠に自動破棄しない。

親Stop hook adapterは有効な手紙をclaimした時だけ、実証済みのhost固有wireでboundedなadvisoryを同じ親turnへ返す。
Codexは`decision:"block"`と`reason`、Claudeは`hookSpecificOutput.hookEventName="Stop"`と
`additionalContext`を使う。plain stdout、exit 2、上位roleへの偽装は使わない。

- 両hostのpayloadで`session_id`をraw parent thread identityとして使う。raw IDはroute照合とhook event digest生成中だけ保持し、
  message、receipt、logへ保存しない。Codexの`turn_id`とClaudeの`prompt_id`もdigest入力に限定する。
- `stop_hook_active=true`のStopでは新しいmessageをclaimしない。同じ親turnで複数のObserver助言を連続注入せず、
  残りは次の通常Stopまでinboxへ残す。
- advisoryはtitle、severity、category、body、evidence、suggested actionを固定順に描画し、全体を16 KiB以下にboundする。
  制御文字は正規化し、message schemaの上限内でもhook contextを無制限に増やさない。
- claim後にrender、stdout書込、final receipt更新のいずれかが失敗した場合は`delivery_unknown`へ回収し、同じ本文を再配送しない。
  回収自体も失敗した時は非0で表面化し、claimed receiptを明示recovery対象として残す。

親Stop hookは、Mailboxなしのfast pathで短時間に終了する。外部LLM、network、大規模project scan、long-pollへ同期依存しない。複数Stop hookは並行起動されるため、Throughline側のchanged判定は最終的な`task_complete`まで進めない。

### 親Stop hookの導入境界

Observerはprovider別のcanonical hook fragmentとread-only verifierを所有する。入力はprovider、absoluteな
`observer-parent-stop-hook` executable path、candidate Host configに限定し、Claude／Codexの設定fileを書き換えない。
macOS v1のcommand pathは実在する実行可能fileであり、空白、制御文字、単一／二重引用符を含まないものだけを受理する。

公開入口は`observer-hook-config`とする。`fragment`／`verify`の双方が`--provider <claude|codex>`と
`--executable <absolute-path>`を受け、`verify`だけが最大1 MiBのstrict UTF-8 candidate config JSONをstdinから読む。
成功はJSON一行、usageはexit 2、その他の既知失敗はcode付きJSON一行をstderrへ返す。Host設定やObserver stateへ書かない。

- Claude fragmentはmatcherなしのstandalone `Stop` entryで、`type=command`、absolute command、bounded `timeout`だけを持つ。
- Codex fragmentはmatcherなしのstandalone `Stop` entryで、`type=command`、absolute command、bounded `timeoutSec`、
  `async=false`、`statusMessage=null`だけを持つ。
- v1のtimeoutは両providerとも5秒、commandは`<absolute-path> --provider <provider>`に固定する。
- fragment schemaは`observer.parent_stop_hook_fragment.v1`、verification schemaは
  `observer.parent_stop_hook_verification.v1`とする。candidateの`hooks.Stop`未定義は`missing`であり、配列以外はinvalidとする。
- verifierは対象commandの0件、複数件、非canonical 1件、canonical 1件をそれぞれ
  `missing`、`duplicate`、`noncanonical`、`canonical`として区別する。他製品のhookをObserver所有と誤認しない。
- 全端末への設定合成、backup、transaction rollback、端末verifyはdotagentsのfactory adapterが所有する。
  dotagentsはObserverのfragmentをconsumeし、message、Mailbox、routing、advisory renderを再実装しない。
- actual apply、hook trust承認、実host発火はHとする。dry-run、isolated HOME test、candidate verifyはHではない。

---

## 10. Security / Privacy

- Observer stateとMailboxはowner-onlyを基本とする。
- symlink、path traversal、owner不一致、不正permissionを拒否する。
- schema、target、expiry、size、digestを検証する。
- prompt全文、secret、credential、token、cookie、private key、巨大logを保存しない。
- repo、Throughline、log、message bodyをuntrusted inputとして扱う。
- message bodyをsystem / developer命令へ昇格させない。
- receiptへbodyを残さない。
- v1では電子署名を実装済みに見せない。

---

## 11. v1非目標・廃案

- Observerを監視対象プロジェクトと同じフォルダで起動する。
- install、SessionStart、project openによるObserverの暗黙起動。
- 同一targetのactive watchを後勝ちで奪う、または二重起動する。
- 一つの親session epochへ複数の論理Observerを対応させる、または複数の物理generationを同時にactiveにする。
- 一つの物理host sessionをwatch終了まで無制限に延命し、会話履歴をObserverのdurable stateとして扱う。
- Mailboxをgit common dirへ置く。
- 利用者が固定の親session IDやControl IDを指定する。
- ObserverがThroughlineのDB、WAL、mtimeを直接監視する。
- 一回のtool呼出しを無期限に開き続ける。
- 同一projectで複数親が同時活動する場合の競合解決。
- Observerによる自動修正、interrupt、cancel、revert。
- 親会話全文の複製または長期保存。
- 複数host間の分散Mailbox。
- 汎用通知サービス、Web UI、大規模rule DSL。
- 厳密なexactly-once配送。

---

## 12. 不変条件

1. Observerは親の仕事と指揮権を奪わない。
2. 正常な沈黙を成功として扱う。
3. Throughlineの内部stateをObserverへ複製しない。
4. Observer固有stateを他製品の管理領域へ置かない。
5. 通知の取りこぼしをfallbackで隠さない。
6. 別projectまたは旧threadの手紙を推測配送しない。
7. 未確認のHost event、注入role、timeout挙動を実装済みに見せない。
8. 進行中turnを完了turnとして監査しない。
9. Observerを親と異なるproviderへ自動配置しない。
10. Observerを継続的な反証役または一般Workerとして扱わない。
11. 利用者の明示指示なしに新しいwatchを起動せず、fault／crash後に自動再起動しない。
    明示起動済みwatch内のparent rebindと計画的context rolloverは、terminal確認付きの正規lifecycleとしてのみ行う。
12. 全hostの`cwd`をcanonicalなObserver rootへ固定し、監視対象ごとの擬似projectやtemporary repoを作らない。
