# Codex Observer 開発計画

**Status:** Active Plan
**作成日:** 2026-07-14
**対象プロダクト:** Observer
**関連資料:** [Codex Observer Mailbox / Done Hook 開発計画案](archive/2026-07_observer-mailbox-proposal.md)

---

## 1. 目的

Observerは、長時間の開発を担当する親AIを外部から継続的に観測し、親が目的や計画から逸脱した時、検証が不足した時、同じ失敗を反復した時、または有益な助言がある時に、証拠付きの短い手紙を届ける独立プロダクトである。

Observerは親AIの仕事を奪わない。

- 親AIが設計、実装、テスト、統合、最終裁定を行う。
- Observerはプロジェクトと親スレッドをread-onlyで観測する。
- Observerは必要な時だけ助言する。
- 重大な場合は`review_required`としてソフトストップを要請する。
- Observer自身は修正、停止、取消、commit、revert、push、deployを行わない。

最終像:

```text
指定されたproject root
        ↓
Throughlineから最新更新の親スレッドを特定
        ↓
wait_for_turn_changeで最大1時間long-poll
        ↓
新規ターン追加でObserverが起床
        ↓
親の発言・plan・diff・git・test証拠を照合
        ↓
no_advisory または一件の助言を中央Mailboxへatomic publish
        ↓
親のDone相当hookが自分宛ての手紙だけをatomic claim
        ↓
親へ一度だけadvisoryとして注入
        ↓
手紙本文を削除しdigest-only receiptを残す
```

---

## 2. 確定した設計裁定

### 2.1 監視対象は親sessionではなくproject root

利用者がObserverへ伝える必須入力は、監視したいプロジェクトの指定フォルダだけとする。

```bash
observer watch /absolute/path/to/project
```

親スレッドは作り直されることを前提とし、固定session IDを利用者へ設定させない。

ObserverはThroughlineから、指定フォルダに属するスレッドのうち、最後に確定ターンが追加された時刻が最新の適格スレッドを現在の親として選ぶ。

v1では、一つのproject targetで同時に活動する親スレッドは一つと仮定する。複数親の競合解決は実装しない。

### 2.2 親スレッドの切替へ自動追従する

新しい親スレッドが同じプロジェクトで開始され、そのスレッドの確定ターン時刻が最新になった場合、Observerは追跡先を自動的に切り替える。

```text
親スレッドAを追跡
  ↓
同じproject rootで親スレッドBに新しい確定ターン
  ↓
Bが最新更新スレッドになる
  ↓
ObserverがBの文脈、plan、現在地を読み直す
  ↓
Bの監視を継続
```

旧スレッド向けの未読手紙を新スレッドへ付け替えない。旧指摘がまだ有効なら、新スレッド上で再評価し、新しいmessage IDで投函する。

### 2.3 Observerは親と別のフォルダで動く

Observer runtime、監視cursor、cooldown、Mailbox、receiptはObserverが所有する領域へ置く。

working tree、Throughlineの管理領域、Codexの管理領域へObserver固有stateを保存しない。

候補:

```text
~/.local/state/codex-observer/
  targets/
    <project-target-id>/
      registry.json
      observer-state.json
      inbox/
      processing/
      failed/
      receipts/
```

最終パスとmacOS / Linux / Windowsの扱いはPhase 0で既存規約と実測により確定する。

### 2.4 Throughlineは親スレッド観測の正規入口

ObserverはローカルのThroughline読み取り口から、対象プロジェクトのスレッドと確定ターンを読む。

- ThroughlineのDBや所有stateへ書き込まない。
- Throughlineの会話履歴をObserver側へ恒久複製しない。
- Observerは最後に評価したturn cursorと、短い監視仮説だけを自身のstateへ保存する。
- Throughlineの追加通知は起床ベルとして扱い、通知後にcursor以降の確定ターンを正規入口から再取得する。

Throughlineには、既存のturn読み取り口とは別に、次のturn追加通知用long-pollを新設する。

```text
wait_for_turn_change(
  project_root,
  after_cursor,
  timeout_seconds = 3600
)
```

役割を分ける。

```text
wait_for_turn_change
  = 指定projectで確定turnが増えたことだけを通知する

既存のturn read入口
  = 通知後に実際のturn本文を取得する
```

ObserverはThroughlineのDB、WAL、mtimeを直接監視しない。変更検知の内部実装と互換性は、記録を所有するThroughlineが引き受ける。

### 2.5 ObserverとThroughlineはlong-poll中に待機する

Observerは常時LLM推論やbusy pollingを行わない。

```text
cursor読取
  ↓
wait_for_turn_change(project_root, cursor, 3600)を呼ぶ
  ↓
ObserverとThroughlineが最大1時間待機
  ↓
親のDoneでThroughlineへ確定turn追加
  ↓
Throughlineがchangedを返してObserverを起こす
  ↓
cursor以降のターンを再取得
  ↓
一回の観測サイクル
  ↓
cursor更新
  ↓
ObserverがDone
  ↓
次のObserverターンで再び最大1時間wait
```

一回のlong-pollは最大3600秒とし、論理的な無期限待機はObserverのturnを繰り返すことで実現する。

1時間更新がなければ、Throughlineはtimeoutを正常応答として返す。Observerは自身のスレッドへ次だけを残してDoneする。

```text
親スレッドの更新がありませんでした。待機します。
```

このtimeout報告を親のMailboxへ送らない。次のObserverターンではcursorを進めず、同じcursorから再び最大1時間待つ。

親の途中状態やtool実行ごとには起こさない。Throughlineへ親の確定ターンが追加されるDone相当の区切りを更新イベントとする。

親側のDone hookを無限待機させない。無期限待機するのは独立したObserver側runtimeだけであり、親側hookは短時間で終了する。

### 2.6 Observerは助言者であり実装者ではない

Observerが読んでよいもの:

- Throughlineの対象親ターン
- `AGENTS.md`などの正典
- 承認済みplanと現在のTODO / Phase
- ソースコードとテストコード
- `git status`、diff、履歴
- Control Record、Run、test evidence、既存ログ

Observerが行ってはならないもの:

- ソース、テスト、文書、設定の編集
- 親の代わりの実装や修正
- Task、Run、Control Record、計画の変更
- Workerまたは別AIの起動
- stage、commit、revert、cancel、interrupt、push、deploy
- H承認の代行
- 親の技術的な停止
- Mailbox以外から親への直接注入

Observerが書き込めるのは、自身のstateとMailboxだけとする。この制約はpromptだけでなく、実行権限でも強制する。

### 2.7 停止はソフトストップだけ

Observerは親を技術的に停止しない。

重大な問題では`review_required`の手紙を送り、親に「次の作業へ進む前に証拠を確認すること」を要請する。止まる、続ける、方針を変えるという最終裁定は親が保持する。

### 2.8 デフォルトは沈黙

Observerの成功は、指摘数では測らない。

```text
問題を多く見つけること
  ≠ 成功

親が今知ることで成果を有意に改善できる事実だけを伝えること
  = 成功
```

各観測サイクルの既定結果は`no_advisory`とする。

---

## 3. システム境界

```text
Throughline
  所有: session、turn、handoff、親の記録
  Observerからの利用: read-only

Observer Runtime
  所有: project registration、turn cursor、監視仮説、cooldown、wait loop

Observer AI
  所有しない: project code、親Task、Control Record
  責務: boundedな観測windowの意味監査

Observer Mailbox
  所有: 未配送の短い助言、配送中状態、digest-only receipt

親Codex Done Hook
  責務: 現在project / thread宛ての手紙だけを短時間で取得して注入

親Codex
  所有: 設計、実装、テスト、統合、助言の採否、最終裁定
```

---

## 4. Project Targetとスレッド解決

### 4.1 Project Target登録

`observer watch <project-root>`は、指定フォルダをcanonical pathとrepo identityへ解決し、安定した`project_target_id`を発行する。

候補schema:

```json
{
  "schema_version": 1,
  "project_target_id": "project-...",
  "configured_root": "/absolute/path/to/project",
  "canonical_root": "/resolved/path/to/project",
  "repo_identity": "sha256:...",
  "created_at": "2026-07-14T12:00:00Z",
  "status": "watching"
}
```

projectがgit管理下でない場合のidentityは、暗黙fallbackせずPhase 0で裁定する。

### 4.2 最新親スレッドの選択

候補アルゴリズム:

```text
1. Throughlineから指定project rootに属するスレッドを列挙
2. Throughlineが提供する種別情報で、親として不適格なsessionを除外
3. 各sessionの最後の確定turn時刻を取得
4. 最大のlast_turn_atを持つsessionを現在の親として選択
5. 前回と異なる場合はsession generationを進め、文脈を読み直す
```

DBファイル自体のmtimeは選択に使わない。Throughlineが保持する確定turnの時刻または単調増加IDを使う。

同時刻、欠損metadata、対象なしの扱いはfail closedとし、Phase 0で実データを見て決める。

### 4.3 追跡state

候補:

```json
{
  "schema_version": 1,
  "project_target_id": "project-...",
  "active_parent_session_id": "thread-B",
  "session_generation": 2,
  "turn_cursors": {
    "thread-A": 184,
    "thread-B": 27
  },
  "last_observed_at": "2026-07-14T12:30:00Z"
}
```

stateには親の会話本文、prompt全文、secret、巨大logを保存しない。

---

## 5. 継続監視ループ

### 5.1 起動

1. project targetを読み込む。
2. Throughlineの正規読み取り口と`wait_for_turn_change`が利用可能か検証する。
3. 対象projectの最新親スレッドを解決する。
4. 保存済みcursorとThroughlineの現在位置を照合する。
5. 未評価turnがあれば先に回収する。
6. 追いついたら`timeout_seconds=3600`でlong-pollへ入る。

### 5.2 Throughline long-poll契約

要求:

```json
{
  "project_root": "/absolute/path/to/project",
  "after_cursor": 184,
  "timeout_seconds": 3600
}
```

指定projectに新しい確定turnがある場合、または待機中に親のDoneで確定turnが追加された場合:

```json
{
  "changed": true,
  "previous_cursor": 184,
  "latest_cursor": 185
}
```

一時間更新がない場合:

```json
{
  "changed": false,
  "reason": "timeout",
  "latest_cursor": 184
}
```

long-poll応答へturn本文を含めない。`latest_cursor`は取得開始点の参考情報であり、Observerは必ず既存read入口から実データを再取得する。

呼出前またはwaiter登録との競合窓で追加されたturnを取りこぼさないことをThroughline側の契約とする。通知の重複またはspurious wakeupは許容し、Observerのcursorで無害化する。

### 5.3 更新通知での起床

1. `changed=true`をturn本文ではなく起床シグナルとして扱う。
2. 最新親スレッドを再解決する。
3. cursor以降の確定turnをThroughlineから再取得する。
4. 複数turnがあれば一つのbounded observation windowへまとめる。
5. plan、diff、git、test evidenceを必要な範囲だけ読む。
6. 一回のObserver AI評価を行う。
7. `no_advisory`または最大一件のpublishを行う。
8. 結果とcursorを原子的に保存する。
9. 未処理turnが増えていればdrainする。
10. 一回の監視結果を残してObserverがDoneする。
11. 次のObserverターンで新しいcursorから再びlong-pollする。

### 5.4 TimeoutとObserver Done

`changed=false`かつ`reason=timeout`の場合、project走査、AI意味監査、Mailbox投函を行わない。

Observerは自身のスレッドへ次の短い状態だけを残す。

```text
親スレッドの更新がありませんでした。待機します。
```

そのturnをDoneで閉じる。次のObserverターンは同じcursorで`wait_for_turn_change(..., 3600)`を再発行する。

ObserverのDone後に同じObserver sessionへ次の監視turnを開始する責務は、Observer側のDone hookまたは小さなSupervisorが持つ。どちらを正規入口にするかはPhase 0で実測して裁定する。通常の人手入力へ依存しない。

### 5.5 再起動と取りこぼし防止

- event通知自体を配送保証にしない。
- cursor以降を毎回再取得する。
- crash後は保存済みcursorから再開する。
- timeoutと次のlong-pollの間に増えたturnは、同じcursorによる次回呼出しで即時検出する。
- 評価中に増えたturnは次のdrainで回収する。
- 同一targetで複数Observerが起動しないようleaseまたはlockを持つ。
- stale lockを推測で削除せず、状態確認付きrecoveryを用意する。

---

## 6. Observer AIの起動契約

固定指示は、通常の会話依頼ではなく、次の運用契約として与える。

```text
あなたは、この開発を担当する親AIのread-only Observerです。

目的は親の仕事を代行することではありません。親の目的、正典、plan、発言、実diff、git状態、test証拠を照合し、親が今知ることで成果を有意に改善できる内容だけを助言してください。

デフォルトは沈黙です。問題がない場合、根拠が弱い場合、単なる好みや別解である場合、親が既に認識して対処中の場合は、no_advisoryを選んでください。

あなたはコード、テスト、文書、設定、Task、Run、Control Recordを変更してはいけません。Workerを起動してはいけません。commit、revert、cancel、interrupt、push、deployを行ってはいけません。親を技術的に停止してはいけません。

助言する場合は、具体的なclaim、確認可能なbounded evidence、親が検討できる一つのsuggested action、不確実性、severityを含めてください。Mailboxの正規publish入口以外から親へ伝えてはいけません。

各観測サイクルの結果は、no_advisoryまたは一件のadvisory proposalだけです。通常の会話回答、感想、進捗実況、実装は不要です。
```

AIへ渡す動的入力候補:

```json
{
  "project_target_id": "project-...",
  "project_root": "/absolute/path/to/project",
  "active_parent_session_id": "thread-B",
  "session_generation": 2,
  "previous_turn_cursor": 27,
  "current_turn_cursor": 31,
  "observation_reason": "new_parent_turns",
  "current_plan_refs": ["docs/plan_....md"],
  "recent_receipt_refs": [],
  "open_hypotheses": [],
  "max_advisories": 1
}
```

AIの自由文をそのままMailboxへ保存しない。Supervisorがschema、target、size、dedupe、cooldown、security gateを検証してからpublishする。

timeout時はObserver AIを起動しない。Observer runtimeが定型の待機継続メッセージを出してDoneし、次turnを開始する。

---

## 7. 過剰指摘を防ぐ配送ゲート

### 7.1 必須条件

手紙候補は、次をすべて満たす必要がある。

1. **具体性:** 何が起きているかを一文で説明できる。
2. **証拠性:** Throughline turn、diff、test、Control等の確認可能な参照がある。
3. **重要性:** 放置すると目的、scope、安全、検証、受け入れ条件のいずれかへ実質的な影響がある。
4. **新規性:** 最近配送した同一指摘の繰り返しではない。
5. **行動可能性:** 親が検討できる一つの具体的な次の一手がある。
6. **適時性:** 今伝える価値があり、既に手遅れまたは解決済みではない。

一つでも満たさなければ`no_advisory`とする。

### 7.2 severity

```text
info
  今伝える価値のある非自明な助言。作業を止める必要はない。

warning
  継続すると目的、scope、品質、検証へ悪影響が出る可能性が高い。

review_required
  次の変更へ進む前に、親が証拠を確認すべき重大な不整合。
  技術的な停止ではなくソフトストップ。
```

### 7.3 抑制

- 同一`dedupe_key`のcooldown中は再投函しない。
- 同じclaimを言い換えただけの手紙を新規扱いしない。
- 親が問題を認識し、具体的な対処を開始している間は抑制する。
- 一回の弱い兆候ではなく、継続または複数証拠を原則とする。
- 安全・契約破壊など重大かつ直接的な証拠は、一件でも`review_required`候補にできる。
- 一観測サイクルあたり最大一件とする。
- targetごとの時間・turn単位の配送budgetを設ける。初期値はdogfoodで決める。
- 手紙を送らなかった理由を親へ逐次報告しない。

### 7.4 検出候補

- stagnation
- repeated_failure
- scope_drift
- verification_gap
- plan_or_phase_drift
- acceptance_mismatch
- unknown_run_neglect
- overengineering
- context_resume_mismatch
- safety_or_permission_risk
- actionable_design_advice

単なるコードスタイル、好み、別解、励まし、一般論は対象外とする。

---

## 8. 中央Mailboxと誤配送防止

### 8.1 物理分離

Mailboxは`project_target_id`ごとに物理的なinboxを分ける。

```text
targets/<project-target-id>/inbox/
```

他projectのinboxを探索して代替配送するfallbackは禁止する。

### 8.2 message target

候補:

```json
{
  "target": {
    "project_target_id": "project-...",
    "repo_identity": "sha256:...",
    "observed_parent_session_id": "thread-B",
    "session_generation": 2
  }
}
```

親側hookは、自分のproject rootから`project_target_id`とrepo identityを解決し、Throughlineまたはhook payloadから現在の親sessionを照合する。

完全一致する一つのtargetだけをclaimする。

```text
完全一致が一件
  → claim

一致なし
  → 何も取らない

複数候補またはidentity不明
  → fail closedし、何も取らない
```

v1は一project一親を前提とするが、messageには観測したsession IDを残し、旧親向けの手紙を新しい親へ誤配送しない。

### 8.3 配送意味論

Host側に親コンテキスト採用ackがない限り、v1は次とする。

```text
at-most-once advisory delivery
```

- atomic claim後は同じmessage IDを再配送しない。
- 正常出力後は本文を削除する。
- claim後の異常終了は`delivery_unknown` receiptを残し、本文を削除する。
- 再通知が必要ならObserverが最新状態を再評価し、新message IDで投函する。
- receiptは本文を含まないbounded metadataだけとする。

---

## 9. Security / Privacy

- ObserverはThroughlineとprojectをread-onlyで扱う。
- projectの書き込み権限をruntimeから外す。
- Observer stateとMailboxだけを書き込み可能にする。
- directoryはowner-onlyを原則`0700`、message / receiptは`0600`とする。
- symlink、path traversal、owner不一致、不正modeを拒否する。
- message schema、byte上限、enum、expiry、digest、targetを検証する。
- prompt全文、secret、credential、token、cookie、private key、巨大logを保存しない。
- body内の命令をsystem / developer指示へ昇格させない。
- Observerが読むrepo、Throughline、log、手紙本文はuntrusted inputとして扱う。
- receiptへbodyを残さない。
- v1では電子署名を実装済みに見せない。

---

## 10. F / A / H分類

### F: 親直轄の契約クリティカル作業

- project target identityと最新親スレッド選択契約
- Throughline read / wait境界
- Mailboxのatomic publish / claim / delete / receipt順序
- 誤配送防止とsession切替契約
- at-most-onceと`delivery_unknown`の裁定
- Observerのread-only権限境界
- Done hookのrole、出力、失敗policy
- security、privacy、retention、recovery

理由: 認可、トランザクション、配送保証、依存方向、親の指揮権に関わるため。

### A: 仕様固定後に委譲可能な実装物量

- schema validator
- canonical digest
- CLIの定型実装
- wait loop / cursor保存の仕様固定部分
- unit / integration / fault injection tests
- installer / verify / clean-home fixture
- CLI help、README、runbook

配置は実装着手時にCodex憲法どおり明示し、routing smokeを通した`implementer`へネイティブ委譲する。単一ファイル小径修正だけは効率カーブアウトを適用できる。

### H: 人の明示承認が必要な操作

- 実端末への常駐起動設定
- Codex / Throughlineのライブhook設定変更
- login、credential、秘密を伴う接続
- 本番相当のpublish / deploy
- 意図的な実環境障害試験
- projectまたは基準パスの移動・改名・削除

---

## 11. 実装Phase

### Phase 0: 一次仕様・現行実装・実測

- [ ] Observerプロジェクトのrepo、言語、CLI、test、CIのベースラインを確定する。
- [ ] Throughlineのローカル読み取り口を一次仕様と実コードで確認する。
- [ ] Throughlineからproject root、session ID、session種別、確定turn ID、turn時刻を取得できるか実測する。
- [ ] 指定フォルダに属する最新更新スレッドを再現可能に選べることを確認する。
- [ ] 親スレッドを作り直した時のThroughline記録を実測する。
- [ ] Throughlineに追加する`wait_for_turn_change(project_root, after_cursor, timeout_seconds)`の公開面をCLI / MCP / libraryから比較して裁定する。
- [ ] Throughlineで親Doneが確定turnとしてcommitされる正確な時点を確認する。
- [ ] 一回3600秒のlong-pollがThroughline runtime、transport、Observer hostで成立するか確認する。
- [ ] long-pollのtimeout、cancel、再接続、shutdown、crash時挙動を確認する。
- [ ] waiter登録前後の競合窓でturn追加を取りこぼさない内部契約を確定する。
- [ ] Observer Done後に同じsessionへ次の監視turnを開始する正規入口を確認する。
- [ ] CodexのDone相当hook event名、payload、発火順、stdout / stderr / exit codeを一次仕様と実測で確定する。
- [ ] Done hookから現在project rootとsession identityを解決できるか確認する。
- [ ] DoneとThroughline turn確定の順序を実測し、同じ区切りで手紙が間に合うか確認する。
- [ ] Observer stateの所有パスとpermission契約を確定する。
- [ ] 既存のAdvisory Hook / Control Record計画との責務重複を整理する。
- [ ] v1で使用するObserver AI runtimeを2〜3案比較して裁定する。
- [ ] 調査結果をRAG / caveat / docsへ還流する。
- [ ] Phase 0のFind → Dedup → 反証 → Critic → 親裁定を一回行う。

**Phase 0 gate:** 未確認のevent名、DB schema、session識別子、hook注入roleを推測で実装しない。

### Phase 1: 安全網と契約固定

- [ ] project target identityのcharacterization testを作る。
- [ ] 最新更新スレッド選択のcharacterization testを作る。
- [ ] 親スレッド切替のcharacterization testを作る。
- [ ] `wait_for_turn_change`の即時changed / 待機changed / 3600秒timeout契約testを作る。
- [ ] long-poll起床後にcursor以降を別readで再取得するtestを作る。
- [ ] timeout後のObserver Doneと同一cursor再待機testを作る。
- [ ] waiter登録競合窓のturn追加を取りこぼさないtestを作る。
- [ ] Observer read-only境界の拒否testを作る。
- [ ] Mailbox publish / claim / delete順序のstate machine testを作る。
- [ ] 誤project、誤session、旧generationの非配送testを作る。
- [ ] Done hook出力の再現testを作る。
- [ ] baseline full gateをgreenにする。
- [ ] Phase 1の重い独立監査を一回行う。

### Phase 2: Project RegistryとMailbox Core

- [ ] `observer watch <project-root>`を実装する。
- [ ] canonical root、repo identity、`project_target_id`を実装する。
- [ ] product-owned state directoryを実装する。
- [ ] owner / mode / symlink / traversal検査を実装する。
- [ ] message schemaとcanonical digestを実装する。
- [ ] atomic publish、duplicate ID拒否、dedupe key検査を実装する。
- [ ] inbox / processing / failed / receiptsを実装する。
- [ ] atomic claim、本文削除、digest-only receiptを実装する。
- [ ] receipt retentionとcleanupを実装する。
- [ ] consumer lockと明示recoveryを実装する。
- [ ] Phase 2の重い独立監査を一回行う。

### Phase 3: Throughline Watcher

- [ ] Throughline側に`wait_for_turn_change(project_root, after_cursor, timeout_seconds)`を実装する。
- [ ] Throughline側で親Doneによる確定turn commit時に対象waiterを起こす。
- [ ] Throughline long-poll応答をchanged / timeoutのbounded metadataだけにする。
- [ ] Throughline側で呼出直前・waiter登録中のturn追加を取りこぼさない。
- [ ] 一回3600秒のlong-pollと正常timeoutを実装する。
- [ ] 指定project rootに属するsession列挙を実装する。
- [ ] 最新確定turn時刻による親スレッド選択を実装する。
- [ ] session generationとthread別cursorを実装する。
- [ ] 親スレッド切替時の再読込を実装する。
- [ ] changed通知後の別readによるcursor再取得とbounded drainを実装する。
- [ ] timeout時の定型報告、Observer Done、同一cursor再待機を実装する。
- [ ] Observer Done後の自動継続turnを実装する。
- [ ] crash / restart / missed notification recoveryを実装する。
- [ ] targetごとの単一Observer leaseを実装する。
- [ ] Observer自身のsessionを監視対象へ混入させないことを確認する。
- [ ] Phase 3の重い独立監査を一回行う。

### Phase 4: Observer AIとノイズ抑制

- [ ] 固定Observer起動契約を実装する。
- [ ] bounded observation windowを実装する。
- [ ] plan、diff、git、test evidenceの最小収集器を実装する。
- [ ] AI出力を`no_advisory`または一件のproposalへ制限する。
- [ ] claim / evidence / materiality / novelty / actionability / timing gateを実装する。
- [ ] severity分類を実装する。
- [ ] dedupe、cooldown、delivery budgetを実装する。
- [ ] 親が認識・対処中の指摘を抑制する。
- [ ] 最小2categoryを実装してdogfoodする。
- [ ] Observerがprojectを編集できないことを権限とtestで確認する。
- [ ] prompt injectionで役割・出力先・禁止事項を上書きできないことを確認する。
- [ ] Phase 4の重い独立監査を一回行う。

### Phase 5: 親Done Hook Adapter

- [ ] Done相当eventだけで中央Mailboxを確認する。
- [ ] project rootから正しい`project_target_id`を解決する。
- [ ] 現在の最新親sessionとmessage targetを照合する。
- [ ] 完全一致する手紙だけをclaimする。
- [ ] advisory境界付きの注入形式を実装する。
- [ ] 件数・総byte上限を実装する。
- [ ] Mailboxなしfast pathを実装する。
- [ ] 同一messageの二重注入を防ぐ。
- [ ] `delivery_unknown`と非再配送を実装する。
- [ ] installer、verify、clean-home、rollbackを実装する。
- [ ] Phase 5の重い独立監査を一回行う。

### Phase 6: DogfoodとFault Injection

- [ ] 一つのprojectをフォルダ指定だけで監視開始する。
- [ ] 親Doneによる確定turn追加でThroughlineが待機中のObserverを起こすことを確認する。
- [ ] 通知後にObserverが既存read入口からturnを取得することを確認する。
- [ ] 一時間更新なしで定型報告を残し、ObserverがDoneすることを確認する。
- [ ] 次のObserver turnで同一cursorから一時間待機を再開することを確認する。
- [ ] 助言不要の通常ターンで手紙を出さないことを確認する。
- [ ] 有益な`info`を一度だけ配送する。
- [ ] `warning`を一度だけ配送する。
- [ ] `review_required`がソフトストップとして表示されることを確認する。
- [ ] 親スレッドを作り直し、最新スレッドへ自動追従することを確認する。
- [ ] 旧スレッド宛ての手紙を新スレッドが取得しないことを確認する。
- [ ] 別projectの手紙を取得しないことを確認する。
- [ ] concurrent Doneで二重配送しないことを確認する。
- [ ] publish、claim、render、receipt、delete、wait、restartをfault injectionする。
- [ ] Mailboxなしfast pathと一件配送のlatencyを測定する。
- [ ] 誤検出率、手紙数、採用率、重複率を記録する。
- [ ] Phase 6の重い独立監査を一回行う。

### Phase 7: 統合と知識還流

- [ ] README、overview、CLI help、runbook、rollbackを同期する。
- [ ] ObserverとThroughlineの所有境界を文書化する。
- [ ] ObserverとControl Record / Advisory Hookの所有境界を文書化する。
- [ ] 未検証hostと既知制約を文書化する。
- [ ] caveat / RAG / testsへ失敗知識を還流する。
- [ ] 全受け入れ条件を対象に最終監査する。
- [ ] 親が最終受け入れを裁定する。
- [ ] 完了後、このplanを既存規則に従ってarchiveする。

---

## 12. Test Matrix

### Project / Thread

- [ ] project root登録
- [ ] canonical path
- [ ] symlink root
- [ ] repo identity一致 / 不一致
- [ ] git / non-git
- [ ] 対象threadなし
- [ ] 最新更新thread選択
- [ ] DB mtimeを選択へ使わない
- [ ] 親thread作り直し
- [ ] session generation更新
- [ ] 旧thread cursor保持
- [ ] Observer自身の除外

### Wait / Cursor

- [ ] 空状態でwait
- [ ] 呼出時点で新規turnありなら即時changed
- [ ] 親Doneによる一turn追加で待機中のlong-pollがchanged
- [ ] 複数turn追加をbatch取得
- [ ] changed応答にturn本文を含めない
- [ ] changed通知後に別readでcursor以降を再取得
- [ ] 3600秒で正常timeout
- [ ] timeout時にAI監査とMailbox投函を行わない
- [ ] timeout時に定型の待機継続メッセージ
- [ ] timeout後にObserver Done
- [ ] 次のObserver turnで同一cursorから再wait
- [ ] timeoutと再waitの間のturn追加を即時回収
- [ ] waiter登録前後のturn追加を取りこぼさない
- [ ] duplicate / spurious wakeupをcursorで無害化
- [ ] 評価中に追加されたturnをdrain
- [ ] 通知取りこぼし後の再開
- [ ] Throughline再起動
- [ ] Observer再起動
- [ ] target停止
- [ ] shutdown
- [ ] duplicate Observer lease
- [ ] stale lock recovery

### Observer Behavior

- [ ] 正常進行で`no_advisory`
- [ ] 単なる好みを抑制
- [ ] 一般論を抑制
- [ ] 既知・対処中の問題を抑制
- [ ] 証拠不足を抑制
- [ ] actionable advice
- [ ] repeated failure
- [ ] scope drift
- [ ] verification gap
- [ ] review_requiredの根拠
- [ ] 一cycle一件上限
- [ ] dedupe
- [ ] cooldown
- [ ] delivery budget
- [ ] prompt injection耐性
- [ ] project編集拒否

### Mailbox / Routing

- [ ] 空inbox
- [ ] 一件配送
- [ ] 複数件のbounded配送
- [ ] 別project
- [ ] 別repo identity
- [ ] 旧session
- [ ] 旧generation
- [ ] target不明
- [ ] target複数一致
- [ ] malformed
- [ ] expired
- [ ] oversized
- [ ] invalid digest
- [ ] wrong owner / mode
- [ ] path traversal
- [ ] symlink
- [ ] duplicate message ID
- [ ] atomic claim
- [ ] concurrent consumer
- [ ] delivery_unknown
- [ ] 本文削除
- [ ] digest-only receipt

### Hook

- [ ] Done以外で消費しない
- [ ] stdout注入
- [ ] stderr診断
- [ ] exit code
- [ ] hook順序
- [ ] Mailboxなしfast path
- [ ] timeout
- [ ] installer
- [ ] verify
- [ ] clean home
- [ ] rollback

---

## 13. v1受け入れ条件

1. 利用者はprojectの指定フォルダだけで監視を開始できる。
2. Observerは親と別のフォルダで動作する。
3. Observer固有stateはObserver所有領域に置かれ、project、Throughline、Codexの管理領域を汚さない。
4. Observerは指定projectに属するThroughlineスレッドから、最終確定turn時刻が最新の親を選ぶ。
5. 親スレッドを作り直しても、最新更新スレッドへ自動追従する。
6. Throughlineは`wait_for_turn_change(project_root, after_cursor, timeout_seconds=3600)`を提供する。
7. ObserverとThroughlineはlong-poll中に待機し、親Doneによる確定turn追加でchanged通知を返す。
8. changed通知はturn本文を含まず、Observerは既存read入口からcursor以降を取得する。
9. 一時間更新がない場合は正常timeoutとなり、Observerは自身のスレッドへ待機継続を一言残してDoneする。
10. 次のObserver turnは同じcursorから再び一時間long-pollし、人手入力なしで監視を継続する。
11. 通知を取りこぼしても、保存済みcursor以降を再取得して回収できる。
12. Observerは親のplan、発言、diff、git、test evidenceをread-onlyで照合できる。
13. Observerはコード、テスト、文書、設定、Task、Run、Control Recordを変更できない。
14. Observerは助言またはソフトストップだけを行い、親を技術的に停止しない。
15. 正常な進行では`no_advisory`を選び、手紙を出さない。
16. 手紙には具体的claim、bounded evidence、一つのsuggested action、不確実性、severityがある。
17. 単なる好み、一般論、既知・対処中、証拠不足の指摘を抑制する。
18. 同一指摘のdedupe、cooldown、delivery budgetが働く。
19. Observerは中央Mailboxの正規入口以外から親へ助言しない。
20. Mailboxはproject targetごとに分離される。
21. 親hookは別project、別repo、旧session、旧generationの手紙をclaimしない。
22. targetが曖昧または解決不能ならfail closedで配送しない。
23. 同一手紙は親へ最大一回だけ注入される。
24. 配送後、手紙本文は削除され、boundedなdigest-only receiptだけが残る。
25. claim後の異常終了は`delivery_unknown`となり、同じ本文を自動再配送しない。
26. malformed、expired、oversized、不正permission、不正digestの手紙を注入しない。
27. 親側Done hookは外部LLM、network、大規模git scan、無期限waitへ同期依存しない。
28. Mailbox不在時のDone hook遅延が実用上無視できる。
29. 親スレッド切替、誤配送、二重配送、crash、wait復帰をdogfoodとfault injectionで確認する。
30. 誤検出率、重複率、配送消失窓、運用限界を文書化する。
31. installer、verify、既存hooks、関連tests、full CIがgreenである。
32. Phaseごとの重い独立監査と最終親裁定を完了する。
33. knowledge returnを完了する。
34. 完了後にplanをarchiveする。

---

## 14. 非目標

- 複数の親スレッドが同じprojectで同時活動する場合の競合解決
- Observerによるコード修正や実装代行
- 自動interrupt、cancel、revert、停止
- 親のTask Graph、Run、Control Record、finalizationの変更
- 親の会話全文の複製・長期保存
- 毎turnの外部AI多重呼出し
- 常時推論による監視
- 複数host間の分散Mailbox
- Slack、メール、Web UI等の汎用通知
- 電子署名基盤
- 厳密なexactly-once配送
- 大規模な監視rule DSL
- 未検証hostを対応済みと扱うこと

---

## 15. Phase 0で答える質問

1. Throughlineの正規read入口と、新設するlong-pollの公開面はCLI / MCP / libraryのどれか。
2. 確定turn IDとlast turn timestampの意味論は何か。
3. project rootとsessionの対応はどのfieldで取れるか。
4. 親、sub-agent、worker等を識別できるmetadataはあるか。
5. 親スレッドを作り直した時、旧・新sessionはどう記録されるか。
6. 一回3600秒のlong-pollはThroughline runtime、transport、Observer hostで成立するか。
7. `wait_for_turn_change`はwaiter登録前後の競合窓をどう閉じるか。
8. long-pollはcancel、timeout、再接続、shutdownをどう扱うか。
9. Observer Done後、同じsessionの次turnを誰が人手なしで開始するか。
10. Observer crash中に増えたturnをcursorで完全に回収できるか。
11. CodexのDone相当hook event名と注入roleは何か。
12. Done hookから現在project rootとsession identityを取得できるか。
13. 親DoneでThroughlineの確定turnがcommitされる正確な順序は何か。
14. Hostに親コンテキスト採用ackはあるか。
15. Observer stateの正式なplatform別保存先はどこか。
16. read-only project観測を実行権限でどう強制するか。
17. Observer AI runtimeを何で起動し、どう再開・回収するか。
18. 初期cooldown、delivery budget、byte上限、receipt retentionはいくつか。
19. 空Mailboxと一件配送の許容latencyはいくつか。

不明点を推測で実装しない。一次仕様、現行code、実測、fault injectionの順で確定する。
