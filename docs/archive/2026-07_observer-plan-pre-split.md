# Observer v1 開発計画

**Status:** Active — Phase 0
**作成日:** 2026-07-14
**正本:** この文書
**参考履歴:** [初期提案](archive/2026-07_observer-mailbox-proposal.md) / [旧ドラフト](archive/2026-07_observer-plan-draft.md)

---

## 1. 目的

Observerは、指定されたプロジェクトで動く親AIをThroughline経由で継続観測し、親の成果を有意に改善できる時だけ助言を届ける独立プロダクトである。

Observerは親の仕事を奪わない。

- 親が設計、実装、テスト、統合、最終裁定を行う。
- Observerは親の確定ターンとプロジェクト状態をread-onlyで観測する。
- Observerは必要な時だけ`info`、`warning`、`review_required`を送る。
- `review_required`はソフトストップであり、親を技術的に停止しない。
- 問題がなければ沈黙する。

---

## 2. v1で確定した仕様

### 2.1 監視対象

- 利用者が指定するのはプロジェクトの絶対パスだけ。
- 親session IDを利用者へ設定させない。
- Throughline上で指定フォルダに属し、最後の確定ターン更新が最新のスレッドを現在の親として追う。
- 親スレッドを作り直した場合は、新しい最新スレッドへ自動追従する。
- v1は一プロジェクトにつき同時に活動する親は一つと仮定する。

### 2.2 Throughline待機契約

Throughlineへ、turn本文を返さないlong-poll入口を追加する。

```text
wait_for_turn_change(
  project_root,
  after_cursor,
  timeout_seconds = 3600
)
```

- 呼出時点ですでに新規確定ターンがあれば即時`changed`を返す。
- なければThroughlineとObserverの双方が最大一時間待機する。
- 親のDoneによって確定ターンが追加されたら`changed`を返す。
- 一時間更新がなければ正常な`timeout`を返す。
- Observerは`changed`後、既存のThroughline read入口からcursor以降の本文を取得する。
- 通知は重複してもよいが、呼出・waiter登録・再接続の境界で更新を失ってはならない。

### 2.3 Observerの監視turn

```text
同じcursorから最大一時間wait
  ├─ changed
  │    └─ turn取得 → 監査 → 必要なら手紙 → Observer Done
  └─ timeout
       └─「親スレッドの更新がありませんでした。待機します。」→ Observer Done

次のObserver turn
  └─ 保存cursorから再び最大一時間wait
```

timeout報告はObserver自身のスレッドだけへ出し、親のMailboxへ送らない。Observer Done後の次turnは人手入力なしで開始する。

### 2.4 権限境界

Observerが読めるもの:

- 対象親のThroughline確定ターン
- `AGENTS.md`、承認済みplan、TODO、Phase
- ソース、テスト、git diff / status / log
- Control Record、Run、既存test evidence

Observerが書けるもの:

- Observer自身のtarget、cursor、dedupe、cooldown state
- Observer所有の中央Mailbox

Observerがしてはならないもの:

- プロジェクトのコード、テスト、文書、設定の変更
- Task、Run、Control Record、planの変更
- Worker起動、実装代行
- stage、commit、revert、cancel、interrupt、push、deploy
- 親の技術的停止

### 2.5 Mailbox

- Observer所有の状態領域へ置き、working treeとThroughline管理領域へ置かない。
- project targetごとにinboxを分離する。
- 手紙にはproject targetと観測元thread IDを持たせる。
- 親Done hookは、現在のprojectと最新threadに一致する手紙だけをclaimする。
- 旧thread向けの手紙を新threadへ付け替えない。必要なら新thread上で再評価して新message IDを発行する。
- 配送は`at-most-once`。claim後の不明終了は`delivery_unknown`とし、同じ本文を再配送しない。
- 配送後は本文を削除し、boundedなdigest-only receiptだけを残す。

### 2.6 助言品質

既定結果は`no_advisory`とする。手紙には次の全てが必要。

1. 具体的なclaim
2. 確認可能なbounded evidence
3. 放置した場合の実質的な影響
4. 親が検討できる一つのsuggested action
5. 最近の手紙と重複しない新規性
6. 今伝える価値がある適時性

単なる好み、別解、一般論、励まし、証拠のない推測、親が対処中の問題は送らない。

---

## 3. 現行アーキテクチャ

```text
親CodexのDone
  ↓
Throughlineが確定turnを保存
  ↓
wait_for_turn_changeがObserverを起こす
  ↓
Observerが既存read入口から新規turnを取得
  ↓
指定projectをread-onlyで照合
  ↓
no_advisory または一件の手紙
  ↓
ObserverがDoneし、次turnで再待機

親Codexの次のDone
  ↓
中央Mailboxから自分宛てだけをclaim
  ↓
advisoryとして一度だけ親へ注入
```

---

## 4. 廃案・v1非採用

次は現行仕様ではない。実装へ戻さない。

- Observerを監視対象プロジェクトと同じフォルダで起動する。
- Mailboxをgit common dirへ置く。
- 利用者が固定の親session IDやControl IDを設定する。
- ObserverがThroughlineのDB、WAL、mtimeを直接監視する。
- 一回のtool呼出しを無期限に開き続ける。
- 同一プロジェクトで複数親が同時活動する場合の競合解決。
- Observerによる自動修正、interrupt、cancel、revert。
- 親会話全文の複製または長期保存。
- 厳密なexactly-once配送。

---

## 5. 実装前に確定が必要な事項

1. Throughlineの正規repo、現行read入口、turn保存経路、cursorの意味論。
2. 親DoneとThroughline確定turn保存の実際の順序。
3. long-pollを公開する正しい面と、一時間待機できるtransport。
4. Codex親Done hookの正式event、payload、stdoutの注入role。
5. Observer Done後に同じsessionの次turnを自動開始する正規入口。
6. Observerのruntime、package、test、CI、platform別state path。

これらはPhase 0で実コードと実測により確定する。推測で実装しない。

---

## 6. F / A / H

### F: 親直轄

- Throughline waitの競合・配送契約
- project / thread解決と誤配送防止
- Mailboxのclaim / delete / receipt順序
- Observerのread-only境界
- 親hookの注入roleと失敗policy

理由: 公開契約、トランザクション、認可、依存方向、親の指揮権に関わるため。

### A: 仕様固定後に委譲可能

- schema validator、CLI、定型実装
- unit / integration / fault injection test
- installer、verify、fixture、help、runbook

実装着手時に配置を宣言し、Codex憲法のrouting gateを通した`implementer`へ委譲する。小径の単一ファイル修正だけは効率カーブアウトを適用できる。

### H: 実行時に明示承認が必要

- 実端末への常駐設定
- Codex / Throughlineのライブhook設定変更
- login、credential、本番publish / deploy
- 意図的な実環境障害試験
- projectまたは基準パスの移動・改名・削除

---

## 7. 実行TODO

### Phase 0: 調査と設計裁定

- [ ] **P0-1 Observerのベースラインを確定する。**
  - 成果物: repo状態、runtime候補、package / test / CI候補を記録した設計メモ。
  - 完了条件: 実装開始に必要な初期化操作と検証コマンドが明記され、未実施のH操作が分離されている。

- [ ] **P0-2 Throughlineの現行契約を実コードで特定する。**
  - 成果物: read入口、turn schema、cursor、project path、Done保存経路のファイル・呼出経路一覧。
  - 完了条件: fixtureまたは実データで、親Done一回に対してどの確定turnが増えるか再現できる。

- [ ] **P0-3 Codex親Done hookを実測する。**
  - 成果物: 正式event名、payload、session / cwd情報、stdout / stderr / exit codeの観測記録。
  - 完了条件: boundedな文字列を親の次コンテキストへ注入できるか、できないかを再現手順付きで裁定できる。

- [ ] **P0-4 Observer継続turnを実測する。**
  - 成果物: 一時間相当のtimeout後、同じObserver sessionへ次turnを人手なしで開始する候補比較。
  - 完了条件: Done hookまたはSupervisorの正規入口を一つ選び、失敗・再開・停止方法を説明できる。

- [ ] **P0-5 v1契約を裁定して安全網を固定する。**
  - 成果物: 採用API、state path、runtime、検証コマンド、characterization test一覧を本プランへ反映。
  - 完了条件: 未確定事項6件が全て解消または明示的blockedになり、独立反証を一回通過する。

**Phase 0 gate:** P0-1〜P0-5が完了するまでプロダクションコードを書かない。

### Phase 1: Throughline wait依存

- [ ] **P1-1 Throughline側に独立した正本プランを作る。**
  - 成果物: Throughline repoの`docs/`に置かれたwait API計画/TODO。
  - 完了条件: API、競合窓、timeout、cancel、再接続、test、rollbackがThroughlineの所有契約として定義される。

- [ ] **P1-2 Throughline側の計画を完遂する。**
  - 成果物: `wait_for_turn_change`とThroughline側test。詳細TODOはThroughline側正本で管理する。
  - 完了条件: 即時changed、待機changed、timeout、呼出競合、再起動のgateがThroughline repoでgreenになる。

- [ ] **P1-3 Observerからblack-box検証する。**
  - 成果物: 公開入口だけを使うcontract test。
  - 完了条件: 短縮timeout fixtureでchanged / timeout / missed-wakeup防止を再現し、3600秒設定が受理される。

**Phase 1 gate:** ObserverがThroughlineのDB / WALへ依存せず、新規turnを失わず待てる。

### Phase 2: 最小Observer loop

- [ ] **P2-1 Observerプロジェクトを初期化する。**
  - 成果物: runtime、package、lint、unit test、CIの最小構成。
  - 完了条件: 空実装のbaseline gateがgreenで、rollback可能な独立commit単位になる。

- [ ] **P2-2 project target登録を実装する。**
  - 成果物: `observer watch <absolute-project-root>`とObserver所有state。
  - 完了条件: 同じprojectを安定して同じtargetへ解決し、別projectと混同せず、working treeを汚さない。

- [ ] **P2-3 最新親スレッド解決を実装する。**
  - 成果物: Throughlineの確定turn時刻から現在親を選ぶresolver。
  - 完了条件: 親スレッドAからBへ作り直したfixtureで、Bの最初の確定turn後に追跡先がBへ切り替わる。

- [ ] **P2-4 一時間wait loopとcursor回復を実装する。**
  - 成果物: changed / timeout / restartを処理する監視loop。
  - 完了条件: timeout時は定型報告だけでDoneし、次turnで同じcursorから再待機し、停止中の更新も回収する。

- [ ] **P2-5 read-only境界を強制する。**
  - 成果物: project read-only、Observer state / Mailbox write-onlyの実行profileと拒否test。
  - 完了条件: Observerによるproject内writeが失敗し、監視とMailbox publishは成功する。

**Phase 2 gate:** 手紙を生成しない最小Observerが、親の再作成と一時間timeoutを含めて継続監視できる。

### Phase 3: Mailboxと親Done hook

- [ ] **P3-1 中央Mailboxの保存・publish契約を実装する。**
  - 成果物: project別inbox、message schema、atomic publish、permission / size / digest検査。
  - 完了条件: 不正messageを拒否し、正常messageを部分書込なしで公開できる。

- [ ] **P3-2 consume transactionを実装する。**
  - 成果物: atomic claim、本文削除、digest-only receipt、`delivery_unknown`、retention。
  - 完了条件: concurrent consumerとfault injectionで同一本文を二重配送しない。

- [ ] **P3-3 誤配送防止を実装する。**
  - 成果物: project targetと観測thread IDによるrouting、旧thread手紙の失効処理。
  - 完了条件: 別project、旧thread、target不明ではclaimせず、現在project / threadだけが取得できる。

- [ ] **P3-4 親Done hook adapterを実装する。**
  - 成果物: Mailbox fast path、bounded advisory render、installer / verify / rollback。
  - 完了条件: Mailboxなしでは短時間で終了し、一件の手紙を一度だけ親へ注入できる。

**Phase 3 gate:** 手動publishした手紙が正しい親へ最大一回だけ届き、本文が残らない。

### Phase 4: Observer AIとノイズ抑制

- [ ] **P4-1 Observer起動契約と出力schemaを実装する。**
  - 成果物: read-only役割、禁止事項、`no_advisory` / advisory proposalの固定契約。
  - 完了条件: 通常会話、実装、自由形式出力へ逸脱した結果をSupervisorが拒否する。

- [ ] **P4-2 bounded evidence収集を実装する。**
  - 成果物: 新規turn、plan、diff、git、test evidenceの最小snapshot。
  - 完了条件: prompt全文、secret、巨大logを保存せず、手紙のclaimを検証できる参照を作れる。

- [ ] **P4-3 過剰指摘抑制を実装する。**
  - 成果物: materiality、evidence、novelty、actionability、timing gateとdedupe / cooldown。
  - 完了条件: 好み、一般論、証拠不足、対処中、同一指摘のfixtureで手紙を出さない。

- [ ] **P4-4 severityと最小dogfoodを完了する。**
  - 成果物: `info`、`warning`、`review_required`の実例と採否記録。
  - 完了条件: 正常進行では沈黙し、有益な助言とソフトストップを各一回だけ配送できる。

**Phase 4 gate:** Observerが親の仕事を奪わず、ノイズより価値の高い助言だけを送る。

### Phase 5: 統合、監査、還流

- [ ] **P5-1 E2Eとfault injectionを完了する。**
  - 成果物: 親Done → Throughline → Observer → Mailbox → 親Doneの統合test。
  - 完了条件: timeout、thread切替、crash、重複通知、誤配送、claim失敗を含むv1受け入れ条件がgreenになる。

- [ ] **P5-2 性能・導入・rollbackを確定する。**
  - 成果物: latency実測、installer、verify、runbook、cleanup、rollback。
  - 完了条件: 空Mailboxと通常waitが開発体験を阻害せず、clean環境で導入・撤去を再現できる。

- [ ] **P5-3 最終監査とknowledge returnを完了する。**
  - 成果物: Find → Dedup → 反証 → Critic → 親裁定、RAG / caveat / docsへの還流記録。
  - 完了条件: P0/P1問題が残らず、全受け入れ条件を親が裁定し、本プランをarchiveできる。

---

## 8. 検証方針

- TODO完了候補ごとに、親が成果物、該当diff、完了条件、関連test、未検証範囲を一回確認する。
- Phase完了時だけ重い独立監査を一回行う。細かなpatchごとに監査を増殖させない。
- Throughline側の実装とgateはThroughline repoで完結させ、Observerからは公開入口だけをblack-box検証する。
- 実装前のbaseline、各Phaseの関連test、最終full CIをgreenにする。
- exact test commandはP0-1 / P0-5で実repoに基づいて確定し、本節へ追記する。

---

## 9. v1受け入れ条件

1. projectの絶対パスだけで監視を開始でき、親スレッド再作成へ自動追従する。
2. 親DoneでThroughlineが確定turnを保存し、最大一時間のlong-poll中のObserverを起こす。
3. timeout時はObserver自身へ待機継続を一言残してDoneし、次turnで同じcursorから自動再待機する。
4. crash、timeout境界、重複通知があっても確定turnを失わず、同じturnを二重監査しない。
5. ObserverはprojectとThroughlineをread-onlyで扱い、実装、停止、Task変更を行えない。
6. 正常進行では沈黙し、証拠・重要性・行動可能性のある助言だけを送る。
7. 別project・旧thread・不正messageを配送せず、正しい手紙を親へ最大一回だけ注入する。
8. 配送後は本文を削除し、boundedなdigest-only receiptだけを残す。
9. 親Done hookはMailboxなしで高速に終了し、外部LLM、network、long-pollへ同期依存しない。
10. E2E、fault injection、installer、verify、rollback、full CI、最終監査、knowledge returnが完了する。

---

## 10. 既知の罠

- long-poll登録前後の競合窓でturnを取りこぼす。
- timeout後にモデルが自力で次turnを開始できると誤認する。
- Observer自身または別projectのThroughline更新で誤起床する。
- 旧threadの手紙を新threadへそのまま配送する。
- promptだけでread-onlyを保証し、実行権限を制限しない。
- 指摘数を成果にして、正常な沈黙を失敗扱いする。
