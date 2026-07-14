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

---

## 3. 監視対象

利用者がObserverへ指定する必須入力は、監視したいプロジェクトの絶対パスだけとする。

```bash
observer watch /absolute/path/to/project
```

- 固定の親session IDやControl IDを利用者へ設定させない。
- Throughline上で指定フォルダに属し、最後の確定ターン更新が最新の適格スレッドを現在の親として追う。
- 親スレッドを作り直した場合、新しいスレッドの確定ターンが最新になった時点で自動追従する。
- v1は、一プロジェクトにつき同時に活動する親は一つと仮定する。
- v1の監視対象hostはClaudeとCodexとする。
- Observerのmodel providerは現在親のhostと一致させる。Codex親にはCodex、Claude親にはClaudeを使う。
- 同じprojectで適格なClaude親とCodex親が同時に活動し一意に解決できない場合はfail closedとし、残レートや推測で選ばない。
- 同時に複数親が活動する場合の競合解決はv1の契約外とする。

DBファイル自体のmtime、`sessions.updated_at`、`bodies`の件数を親選択へ使わない。Codexはrolloutの`task_complete`、ClaudeはPhase 0で実hostから確定した完了証拠だけを使い、Throughlineが返すhost-bound cursorと完了時刻から現在親を解決する。

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
- 手紙にはproject targetと観測元thread IDを持たせる。
- 親Stop hookはpayloadの現在project / threadと一致する手紙だけをclaimする。
- 旧thread向けの手紙を新threadへ付け替えない。
- 旧指摘が有効なら新thread上で再評価し、新message IDを発行する。
- 別project、旧thread、target不明、target複数一致ではfail closedとする。

配送意味論:

```text
at-most-once advisory delivery
```

- atomic claim後は同じmessage IDを再配送しない。
- 正常配送後は本文を削除する。
- claim後の不明終了は`delivery_unknown`とし、同じ本文を再配送しない。
- 正常receiptのresultは`emitted_unacked`とする。Hook JSONを正常に出力してexit 0に到達したことだけを表し、Hostが親contextへ採用したというackを偽装しない。
- Host ackが存在しないv1では`delivered`というresult名を使わない。
- receiptには本文を含めず、boundedなdigestと配送metadataだけを残す。
- 完了receiptの既定retentionは30日かつ最大1000件とし、古いものから削除する。未完了の`claimed` receiptは件数・日数cleanupで自動削除せず、明示recoveryの対象とする。
- consumer lockはowner nonceを持つ。残留lockは観測したnonceを指定する明示recoveryだけで削除し、時刻だけを根拠に自動破棄しない。

親Stop hook adapterは有効な手紙をclaimした時だけ、実証済みのhost固有wireでboundedなadvisoryを同じ親turnへ返す。Codexの`decision:"block"`と`reason`はCodex adapterだけのwireとし、Claude adapterはClaudeの正式event／payload／continuation契約をPhase 0で確定してから実装する。plain stdoutや上位roleへの偽装は使わない。

親Stop hookは、Mailboxなしのfast pathで短時間に終了する。外部LLM、network、大規模project scan、long-pollへ同期依存しない。複数Stop hookは並行起動されるため、Throughline側のchanged判定は最終的な`task_complete`まで進めない。

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
