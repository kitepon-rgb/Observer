# Codex Observer Mailbox / Done Hook 開発計画案

**Status:** Proposal
**作成日:** 2026-07-14
**対象:** `dotagents`
**位置づけ:** 現行の Elastic Multi-Agent Orchestrator / Advisory Hook 構想に接続する独立サブプラン

---

## 1. 目的

親Codexが長時間の開発を続けている間、外部の監視役が作業状態を観測し、必要な助言を「手紙」として投函できるようにする。

親Codex側は、**Done相当のhookが発火するたびに未読の手紙を確認し、一度だけ親コンテキストへ注入し、読取済みの手紙本体を廃棄する**。

本計画の中心は監視AIそのものではなく、次の配送契約である。

```text
Observer
  └─ 助言をMailboxへ原子的に投函
          ↓
CodexのDone相当hook
  └─ 対象の未読手紙を原子的に取得
          ↓
親Codexの次ターンへ一度だけ注入
          ↓
手紙本体を削除
          ↓
本文を含まない配送receiptだけを残す
```

監視役が何を、どの頻度で、どのモデルを使って観測するかは、既存のControl Record、hooks、Throughline、git、tests、Executor群を調査したうえで開発側が提案する。

ただし、監視実装がどの方式であっても、親への助言は本計画のMailbox契約を通す。

---

## 2. 背景

長時間開発では、親AIが次の状態へ陥りうる。

- 同じ失敗経路の反復
- 計画外のscope拡大
- TODOやPhaseの逸脱
- test証拠なしの完了宣言
- unknown Runの放置
- 大量diffに対する監査不足
- 同じ仮説への過剰投入
- context圧縮後の判断ドリフト
- 疲労に相当する判断品質の低下
- 「長時間作業した」ことを進捗と誤認

親の会話全文を常時保存・監視する必要はない。

Control Record、git、test、Run状態、Done時の成果主張など、boundedな観測情報から異常候補を抽出し、必要な時だけ外部Observerが助言すればよい。

親への助言を毎回直接注入すると、同じ助言が何度も読まれたり、hook再実行で重複したりする。

そのため、**one-shot mailbox**を導入する。

---

## 3. 基本原則

### 3.1 役割分離

```text
Hook
  = センサー兼配送員

Mailbox
  = 一度だけ届ける一時配送路

Observer
  = 状態の解釈、反対仮説、助言生成

Control Record
  = 実行状態と参照

親Codex
  = 最終裁定、設計、実装、統合
```

Hookは監視判断の本体にしない。

Observerは第二の親にならない。

Control RecordはObserverの会話履歴や手紙本文の恒久保存先にしない。

---

### 3.2 Doneを主配送クロックにする

親CodexのDone相当イベントを、手紙確認の主トリガーとする。

理由:

- 親が作業の一区切りを宣言した直後である
- コマンド単位よりノイズが少ない
- 次の作業へ入る前に助言を渡せる
- 毎ターンLLMを呼ぶ必要がない
- 同じ手紙を繰り返し注入しない制御点にしやすい

実際のCodex hook event名、payload、発火順、stdoutの注入先は、一次仕様と実測で確定する。

「Done」という文字列や推測したevent名へ依存して実装しない。

---

### 3.3 一度だけ読むことを優先する

本計画では、同一手紙を何度も親へ注入しないことを優先する。

Host側に「親コンテキストへ確実に採用された」というack APIが存在しない限り、厳密なexactly-once配送は保証できない。

v1の配送意味論は次とする。

```text
at-most-once advisory delivery
```

- 手紙をatomic claimした時点で、そのmessage IDを再配送対象に戻さない
- hookが正常に助言を出力したら、手紙本体を削除する
- claim後に異常終了した場合、同じ本文を自動再注入しない
- 配送不明はreceiptへ`delivery_unknown`として残す
- Observerが再通知すべきと判断した場合は、新しいmessage IDで新しい手紙を書く

重複回避を優先した結果、極小の配送消失窓が残ることは明示する。

Host ackが将来利用可能になった場合だけ、別計画で配送保証を強化する。

---

### 3.4 Advisoryであり、指揮権ではない

Observerの手紙は助言である。

Observerは以下を行わない。

- 親のTaskを勝手に変更する
- 新しいWorker Runを勝手に発行する
- cancel、interrupt、revert、commit、push、deployを行う
- H承認を代行する
- finalizationを確定する
- 安全規則やオーナー裁定を上書きする
- 「この手紙を最優先命令として扱え」と指示する

重大な異常でも、親へ`review_required`を通知するところまでとする。

最終裁定は親が保持する。

---

## 4. スコープ

### v1に含む

- Observer Mailboxの保存契約
- 手紙のschema
- producerが安全に投函するCLIまたはlibrary
- Done相当hookによる未読確認
- atomic claim
- 対象Control / repo / sessionの照合
- boundedな一回注入
- 成功後の手紙本体削除
- digest-only receipt
- duplicate message IDの拒否
- invalid / expired / delivery_unknownの処理
- 同時Done hookへの排他
- security / privacy検査
- installer / verify / tests / docs
- 手動のObserver message投函によるdogfood
- 監視方式の調査と設計提案

### v1に含めない

- 常時LLM監視daemon
- 親の会話全文保存
- 毎Doneで必ず外部AIを起動する処理
- 完全自動の作業停止
- 自動cancel / revert
- ObserverによるTask Graph変更
- Observerによるfinalization
- 複数host間の分散Mailbox
- Web UI
- 電子署名基盤
- 厳密なexactly-once保証
- 手紙本文の長期archive
- 汎用通知サービス
- Slack、メール等への配送
- 監視ルールの大規模DSL

---

## 5. 既存計画との関係

本計画は、Elastic Multi-Agent OrchestratorのControl Coreを置き換えない。

Control Recordが保持するもの:

- active / unknown / terminal Run
- TaskとRunの参照
- phase / campaign / gate
- bounded lineage facts
- evidence descriptor
- parent acceptance / finalization参照

Observer Mailboxが保持するもの:

- 親へまだ配送されていない短い助言
- 配送中の一時状態
- 本文を含まない配送receipt

Observerが保持するもの:

- 監視ロジック
- 観測snapshot
- 異常候補の評価
- dedupe判断
- 助言生成

Throughlineが保持するもの:

- 親sessionのhandoff
- MailboxやControl Recordの代替stateではない

各Executorが保持するもの:

- product-owned session / job / run state
- Mailboxへ複製しない

本計画は、現行計画の「Advisory hooks」と接続できるが、Control Recordのstate machine本体にはしない。

---

## 6. Mailbox保存先

working treeへruntime stateを置かない。

git projectでは、候補保存先を次とする。

```text
<absolute git common dir>/
  dotagents/
    orchestrate/
      observer-mailbox/
        <target-id>/
          inbox/
          processing/
          failed/
          receipts/
```

`<target-id>`は原則としてControl IDとする。

Controlが存在しない単純Taskへの対応が必要なら、repo identityまたは明示的session targetを別設計として追加する。

linked worktreeをまたぐ親・Observerから同じMailboxを見られる必要があるため、worktree固有git dirではなくgit common dirを優先する。

non-git環境では暗黙fallbackしない。

必要なら明示的`--mailbox-dir`を別裁定で許可する。

### 所有権とpermission

- Mailbox directoryはowner-only
- directoryは原則`0700`
- message / receiptは原則`0600`
- symlinkを拒否
- owner不一致をfail closed
- repo外へのpath traversalを拒否
- Windows等で同等の保証を実証できない場合は`unsupported`または`unverified`とする
- 自動的なpermission緩和を行わない

---

## 7. 手紙schema

候補:

```json
{
  "schema_version": 1,
  "message_id": "obs-20260714-0001",
  "producer": {
    "producer_id": "codex-sidecar-observer",
    "kind": "observer"
  },
  "target": {
    "repo_identity": "sha256:...",
    "control_id": "C-001",
    "parent_session_id": null
  },
  "created_at": "2026-07-14T12:00:00Z",
  "expires_at": "2026-07-15T12:00:00Z",
  "severity": "warning",
  "category": "stagnation",
  "dedupe_key": "stagnation:P2-sidecar:failure-abc",
  "title": "同一失敗経路を反復しています",
  "body": "同一failure fingerprintを4回観測しました。新規実装を止め、失敗仮説を独立refuterへ渡すことを検討してください。",
  "evidence_refs": [
    "control:C-001/run:R-031",
    "test:fingerprint-abc"
  ],
  "suggested_action": "反証Taskを一件作成し、現在案の前提を独立に検査する",
  "content_digest": "sha256:..."
}
```

### 必須条件

- `message_id`はMailbox内で一意
- `target.control_id`または明示targetが必須
- `created_at`が必須
- `expires_at`が必須
- `severity`と`category`はbounded enum
- `title`、`body`、`suggested_action`にbyte上限
- `evidence_refs`は件数・長さ上限あり
- `content_digest`はcanonical message contentから計算
- prompt全文、secret、credential、巨大logを含めない
- 実行可能scriptをmessage bodyとして扱わない
- 添付ファイルをv1では許可しない

### severity候補

```text
info
warning
review_required
```

`review_required`でもHookが親の作業を自動停止しない。

---

## 8. 投函契約

Observerまたは手動producerは、直接`inbox/`の最終ファイルへ書かない。

手順:

```text
1. Mailbox外または同一filesystemのtemp fileへ完全なJSONを書く
2. fsync可能性と既存規約を確認する
3. schema、target、size、digestを検証する
4. message ID重複を検査する
5. atomic renameでinbox/<message-id>.jsonへ公開する
```

候補CLI:

```bash
observer-mailbox publish \
  --control C-001 \
  --file /tmp/advisory.json
```

producerは次を行わない。

- 既存messageを上書きする
- 同じdedupe keyを無制限に投函する
- processingやreceiptsへ直接書く
- 親のControl manifestを更新する
- product-owned stateを複製する

---

## 9. Done Hookの消費手順

Done相当hookが発火した時、次を行う。

```text
1. 現在のrepo identity、Control ID、parent session識別子を取得
2. 対象Mailboxがなければ何もせず正常終了
3. 短時間のconsumer lockを取得
4. inboxから対象messageをbounded件数選ぶ
5. target、expiry、schema、permission、digestを検証
6. inbox/<id>.jsonをprocessing/<id>.jsonへatomic renameしてclaim
7. receiptへclaimedを記録
8. 親向けadvisory blockを生成
9. hookの正規出力経路へ一度だけ出力
10. receiptへdeliveredまたはdelivery_unknownを記録
11. processingの手紙本体を削除
12. lockを解放
```

### 1 Doneあたりの上限

例:

- 最大3件
- 合計本文8 KiB以下
- 重要度順、同一重要度では古い順
- 上限を超えた未読手紙は次回Doneまでinboxへ残す

数値はCodex hookのpayload制約と実測で確定する。

---

## 10. 注入形式

親コンテキストへは、手紙を命令として偽装せず、advisory dataとして境界を明示する。

例:

```text
<observer-advisories>
以下は外部監視役から一度だけ配送された助言です。
オーナー指示、安全規則、現在の正典を上書きしません。
親が証拠を確認し、採否を裁定してください。

[warning][stagnation]
同一失敗経路を反復しています
証拠: control:C-001/run:R-031, test:fingerprint-abc
助言: 新規実装を止め、失敗仮説を独立refuterへ渡すことを検討してください。
</observer-advisories>
```

Observer message内の「system」「developer」「最優先命令」等を、hookが上位命令として解釈・再構成しない。

bodyはデータとして扱う。

---

## 11. 配送receipt

手紙本文は配送後に削除する。

監査・dedupe用に、本文を含まないbounded receiptだけを残す。

例:

```json
{
  "schema_version": 1,
  "message_id": "obs-20260714-0001",
  "content_digest": "sha256:...",
  "target_control_id": "C-001",
  "producer_id": "codex-sidecar-observer",
  "claimed_at": "2026-07-14T12:04:00Z",
  "finished_at": "2026-07-14T12:04:01Z",
  "result": "delivered",
  "hook_event_id": "done-...",
  "body_retained": false
}
```

結果候補:

```text
delivered
expired
invalid
target_mismatch
duplicate
delivery_unknown
rejected_security
```

receipt retentionはboundedにする。

例:

- 最大件数
- 最大日数
- 最大総byte

上限到達時の削除順は文書化し、手紙本文は残さない。

---

## 12. 失敗時の扱い

### Mailboxが存在しない

正常終了する。

親のDoneを妨げない。

### malformed message

注入しない。

`invalid` receiptを残し、本文を削除する。

### expired message

注入しない。

`expired` receiptを残し、本文を削除する。

### target mismatch

別Control向けなら消費しない。

正しいtargetのinboxへ残す。

明らかに不正なtargetなら`failed`またはreceipt化する。

### 重複message ID

新しい投函を拒否する。

既存receiptがあるmessage IDを再利用しない。

### hookがclaim後に失敗

同じmessage IDを自動再注入しない。

`delivery_unknown`として本文を削除し、Observer側が必要なら新message IDで再評価・再通知する。

### 同時に複数Done hookが動く

atomic renameと短時間consumer lockにより、一つのmessageを一つのconsumerだけがclaimする。

lock残留を自動削除しない。

状態を確認した親の明示recoveryを用意する。

### receipt書込失敗

本文を何度も再注入するより、fail closedを優先する。

正確な削除順はfault injectionで確定する。

---

## 13. 監視役の要件

監視実装の方式は開発側が調査・提案する。

候補入力:

- Control Record
- current Phase / campaign / TODO
- active / unknown / terminal Run
- parent acceptanceの進捗
- git HEAD / dirty / changed files / diff量
- scope外変更
- test結果とfailure fingerprint
- 同一失敗の反復
- 最後に受け入れ条件が閉じた時刻
- worktree状態
- budget / wall time
- Throughline handoff
- Done時の成果主張
- planの非目標
- unresolved / unknown / uncollected一覧

候補実装:

- ローカルrule-based detector
- codex-sidecar read-only observer
- gpt-connector consultation
- aiterm上の継続監督session
- 複数方式の組み合わせ

推奨原則:

```text
軽量な形式検出
  → 異常候補だけを意味監査
  → 必要な時だけ手紙を投函
```

毎Doneで必ず外部LLMを呼ばない。

監視役は、少なくとも次を検出候補として評価する。

- stagnation
- scope drift
- repeated failure
- verification gap
- unknown Run放置
- plan / Phase逸脱
- overengineering
- acceptance claimと実状態の不一致
- context再開後の状態不整合

ただし、検出rule、閾値、モデル選定、実行頻度は、dogfoodと誤検出率を見て決める。

---

## 14. Observerの出力品質

悪い手紙:

```text
もっと注意してください。
進捗が遅いです。
頑張ってください。
```

良い手紙:

```text
主張:
同一failure fingerprintを4回反復し、直近90分で受入条件が閉じていません。

証拠:
R-031, R-034, R-036, test:fingerprint-abc

助言:
新規実装を止め、現在案の前提を独立refuterへ渡してください。
```

手紙には原則として次を含める。

- category
- 具体的なclaim
- bounded evidence refs
- 親が検討できる一つのsuggested action
- 未確認事項
- severity

Observerは確信できない内容を断定しない。

---

## 15. Hook性能要件

Done hookは親の開発体験を壊してはならない。

- Mailboxなしのfast pathを用意する
- 外部LLMを同期呼出ししない
- networkへ依存しない
- 大規模git scanを毎Doneで行わない
- Mailbox確認とbounded validationだけにする
- timeoutを短くする
- hook失敗をDone全体のhard failureにするかは、既存hook契約と実測で裁定する
- advisory配送失敗をsuccessへ偽装しないが、親作業を無制限に止めない
- stdout / stderrの正規用途を確認する

性能目標は実測後に定める。

例:

```text
空Mailbox: p95 50ms未満
1メッセージ: p95 150ms未満
```

数値は暫定であり、host環境に合わせて裁定する。

---

## 16. Security / Privacy

Mailboxは親コンテキストへの入力経路であるため、ローカルファイルでも無条件に信用しない。

必須:

- producer allowlistまたはowner-only publication
- schema validation
- byte上限
- path traversal拒否
- symlink拒否
- permission / owner検査
- target照合
- content digest検証
- control / repo identity照合
- expiry
- message ID一意性
- bodyを命令階層として昇格させない
- prompt、secret、credential、token、巨大logを保存しない
- receiptへ本文を残さない

v1では電子署名を実装済みに見せない。

同一OS user配下でのowner-only mailboxを信頼境界とする場合、その限界を文書化する。

---

## 17. CLI / ファイル候補

既存規約と照合して最終決定する。

候補:

```text
bin/codex-observer-mailbox-hook.sh
bin/observer-mailbox.mjs
```

候補コマンド:

```bash
observer-mailbox init --control C-001
observer-mailbox publish --control C-001 --file advisory.json
observer-mailbox list --control C-001
observer-mailbox consume --control C-001 --hook-event done-123
observer-mailbox receipts --control C-001
observer-mailbox recover-lock --control C-001
observer-mailbox verify --control C-001
observer-mailbox cleanup --control C-001
```

Hookは`consume`相当を呼ぶ薄いadapterにする。

監視ロジックをhook shellへ埋め込まない。

---

## 18. 実装Phase

### Phase 0: 調査と設計裁定

- [ ] CodexのDone相当hook event名、payload、発火順、注入経路を一次仕様・実測で確定する。
- [ ] 現行`onset-gate-hook`、`codex-callout-hook`、設定fragment、installer、verify、testsを確認する。
- [ ] 新規hookが必要か、既存hookの一責務として追加すべきかを裁定する。
- [ ] Control ID、repo identity、parent session targetの取得方法を確定する。
- [ ] git common dir保存が現行Control Recordと競合しないことを確認する。
- [ ] Done hookのstdout / stderr / exit codeが親へどう反映されるか再現testを作る。
- [ ] Host ack不在時のat-most-once配送を正式に裁定する。
- [ ] Observer監視方式を2〜3案比較し、v1 producerを提案する。
- [ ] privacy、permission、retention、cleanup境界を確定する。

### Phase 1: Mailbox Core

- [ ] message schemaを実装する。
- [ ] canonical digestを実装する。
- [ ] owner / mode / symlink / traversal検査を実装する。
- [ ] atomic publishを実装する。
- [ ] message ID / dedupe key検査を実装する。
- [ ] inbox / processing / failed / receiptsを実装する。
- [ ] bounded receipt retentionを実装する。
- [ ] consumer lockと明示recoveryを実装する。
- [ ] 本文削除とdigest-only receiptを実装する。
- [ ] unit testsをgreenにする。

### Phase 2: Done Hook Adapter

- [ ] Done相当eventだけでMailboxを確認する。
- [ ] 現在targetを安全に解決する。
- [ ] target一致メッセージだけをclaimする。
- [ ] 件数・総byte上限を実装する。
- [ ] advisory境界付きの注入形式を実装する。
- [ ] 同一messageの二重注入を防ぐ。
- [ ] Mailboxなしのfast pathを実装する。
- [ ] hookの失敗分類とexit policyを確定する。
- [ ] installer / verify / clean-home testsを更新する。

### Phase 3: Manual Producer Dogfood

- [ ] 手動CLIでinfo / warning / review_requiredを投函する。
- [ ] Doneごとに一度だけ配送されることを確認する。
- [ ] 読取後に手紙本体が削除されることを確認する。
- [ ] receiptに本文が残らないことを確認する。
- [ ] 上限超過メッセージが次のDoneへ残ることを確認する。
- [ ] linked worktreeと複数parent候補でtarget誤配送がないことを確認する。
- [ ] concurrent Done hookを再現する。
- [ ] crash / claim / delivery_unknownをfault injectionする。

### Phase 4: Observer Producer

- [ ] 監視入力sourceとownershipを確定する。
- [ ] 最小snapshotを定義する。
- [ ] stagnation、scope drift、verification gap、unknown Runのうち最小2種を実装する。
- [ ] 形式検出とAI意味監査を分離する。
- [ ] 同一指摘のdedupe / cooldownを実装する。
- [ ] ObserverがMailbox以外から親へ直接注入しないことを確認する。
- [ ] Observerがcode / Control / Executor stateを勝手に変更しないことを確認する。
- [ ] 誤検出率とノイズをdogfoodで評価する。

### Phase 5: 統合と知識還流

- [ ] Elastic OrchestratorのAdvisory Hook計画との責務重複を解消する。
- [ ] Codex / Claude appendixで共有可能なMailbox coreと親固有hookを分離する。
- [ ] README、overview、skill、CLI help、rollbackを同期する。
- [ ] caveat / RAG / testsへ失敗知識を還流する。
- [ ] 独立refuterで配送重複、target誤り、prompt injection、permission、crashを監査する。
- [ ] 親が受け入れ条件を裁定する。
- [ ] 完了後にplanを既存規則どおりarchiveする。

---

## 19. Test Matrix

### 基本配送

- [ ] 空inbox
- [ ] 1件配送
- [ ] 複数件配送
- [ ] 件数上限
- [ ] byte上限
- [ ] 重要度順
- [ ] 古い順
- [ ] 次Doneへの持ち越し
- [ ] 配送後の本文削除
- [ ] digest-only receipt

### 重複

- [ ] 同一message IDの再投函拒否
- [ ] 既存receipt IDの再利用拒否
- [ ] 同一dedupe keyのcooldown
- [ ] hook再実行で二重注入しない
- [ ] concurrent consumerで二重注入しない

### Target

- [ ] 正しいControl
- [ ] 別Control
- [ ] repo identity不一致
- [ ] parent session指定一致
- [ ] parent session指定不一致
- [ ] Control不明
- [ ] linked worktree
- [ ] main worktree

### Validation

- [ ] malformed JSON
- [ ] unknown schema version
- [ ] digest不一致
- [ ] expired
- [ ] oversized body
- [ ] evidence件数超過
- [ ] invalid enum
- [ ] path traversal
- [ ] symlink
- [ ] wrong owner
- [ ] wrong mode
- [ ] duplicate filename / message ID不一致

### Failure Injection

- [ ] publish途中crash
- [ ] atomic rename前crash
- [ ] claim後crash
- [ ] advisory render中crash
- [ ] stdout出力後crash
- [ ] receipt書込失敗
- [ ] delete失敗
- [ ] lock残留
- [ ] recovery操作
- [ ] delivery_unknownの非再配送

### Hook

- [ ] Done以外で消費しない
- [ ] Mailboxなしfast path
- [ ] hook timeout
- [ ] stdout注入
- [ ] stderr診断
- [ ] exit code
- [ ] 既存hookとの順序
- [ ] installer
- [ ] verify
- [ ] clean home
- [ ] rollback

### Security

- [ ] message内の命令昇格を防ぐ境界表示
- [ ] secret patternを保存しない
- [ ] 巨大logを保存しない
- [ ] producer allowlist
- [ ] repo / Control target照合
- [ ] receiptにbodyが残らない

---

## 20. v1受け入れ条件

1. Observerまたは手動producerが、working treeを汚さず手紙をatomic publishできる。
2. CodexのDone相当hookが、対象Mailboxを毎回確認できる。
3. 同一手紙は親へ最大一回だけ注入される。
4. 正常配送後、手紙本文は削除される。
5. 配送後に残るのはboundedなdigest-only receiptだけである。
6. 別Control、別repo、別session向けの手紙を誤配送しない。
7. malformed、expired、oversized、不正permissionの手紙を注入しない。
8. concurrent Done hookでも一つのmessageを二重消費しない。
9. claim後の異常終了で同じ本文を自動再注入しない。
10. `delivery_unknown`を明示できる。
11. Mailbox不在時、Done hookへ実用上無視できる遅延しか加えない。
12. Hookは外部LLM、network、大規模git scanへ同期依存しない。
13. Observerの手紙はadvisoryとして注入され、上位指示を偽装しない。
14. Observerは親のTask、Run、code、H承認、finalizationを直接変更しない。
15. prompt全文、secret、credential、巨大outputをMailboxへ保存しない。
16. main / linked worktreeで共通targetを正しく解決できる。
17. installer、verify、既存hooks、既存skills、`make ci`がgreenである。
18. 手動producerによるdogfoodを完了する。
19. 最小Observer producerによるdogfoodを完了する。
20. 誤検出、配送重複、配送消失窓、運用限界を文書化する。
21. knowledge returnを完了する。
22. 親の最終裁定後にplanをarchiveする。

---

## 21. 開発側が最初に答えるべき質問

1. Codexで「Done」に相当する正確なhook eventは何か。
2. そのhookの出力は親の次ターンへどの権限・roleで注入されるか。
3. Hook完了をHostがackする仕組みはあるか。
4. 現在の親session IDを安全に取得できるか。
5. Control IDをHookから確実に解決できるか。
6. 複数親sessionが同じControlを開いている場合、どの親が消費すべきか。
7. git common dir Mailboxが現行Control stateと同じlock領域を使うべきか。
8. receiptの最小retentionはどれくらいか。
9. `delivery_unknown`をObserverが再評価する入口は何か。
10. Observer producerはローカルrule、codex-sidecar、gpt-connector、aitermのどれを第一候補にするか。
11. 監視snapshotの正本は何か。Control Recordを複製しない設計になっているか。
12. Done hookの許容latencyはどれくらいか。
13. `review_required`を親へどう見せれば、命令上書きにせず十分目立たせられるか。
14. Windows等の未検証hostをどう扱うか。
15. 既存Advisory Hook計画へ統合するか、独立hookにするか。

不明点を推測で実装しない。

一次仕様、現行code、実測、fault injectionの順で確定する。

---

## 22. 最終像

```text
親Codexが開発
  ↓
Control / git / tests / Runsに観測可能な変化
  ↓
監視役が必要な時だけ評価
  ↓
具体的な証拠付き助言を作成
  ↓
Observer Mailboxへatomic publish
  ↓
親CodexのDone相当hook
  ↓
対象手紙をatomic claim
  ↓
親へadvisoryとして一度だけ注入
  ↓
手紙本文を削除
  ↓
digest-only receipt
  ↓
親が助言を採用・棄却して次の作業を裁定
```

本設計の核心は、常時監視の豪華さではない。

```text
監視役が必要な助言を書けること
親が区切りごとに一度だけ読めること
同じ助言を何度も読まないこと
助言が親の指揮権を奪わないこと
```

この4点を、単純で監査可能な配送契約として実装する。
