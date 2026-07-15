# Observer v1 実装計画

**Status:** Active — Claude／Codex両host対応へ改訂（Throughline変更hold）

**作成日:** 2026-07-14

**製品契約:** [00_product-contract.md](00_product-contract.md)

この文書は作業の現在地だけを管理する。製品仕様、非目標、廃案、恒久規約は製品契約または`AGENTS.md`を正とする。

---

## 未確定事項

completed-turn境界の初期未確定事項は解消済み。Claude側の完了証拠、Stop hook、60秒超wait、continuation、停止方法はP0-6で実測し、Codexの挙動から推測しない。Codex native childのread-only不成立はP2-5 blockerとして[ADR 0008](adr/0008-codex-readonly-host-boundary.md)で分離する。

---

## オーナーhold

- Throughline repoのsource、test、package、hook、設定は変更しない。
- Throughline側へ最初の実装変更を入れる直前で停止し、オーナーへ報告する。
- hold中は、Observer単体で完結するP2-1、P2-2、P3-1、P3-2の基盤を先行できる。
- fake Throughline CLIをtest境界に使ってよいが、未実装の実Throughline APIを成功扱いしない。

---

## Phase 0: 調査と設計裁定

- [x] **P0-1 Observerのベースラインを確定する。**
  - 成果物: repo状態、runtime候補、package / test / CI候補を記録した設計メモ。
  - 完了条件: 初期化操作、標準検証コマンド、H操作が分離されている。

- [x] **P0-2 Throughlineの現行契約を実コードで特定する。**
  - 成果物: read入口、turn schema、cursor、project path、Done保存経路のファイル・呼出経路一覧。
  - 完了条件: fixtureまたは実データで、`task_complete`済みturnと現行DB projectionの差を再現し、完了証拠を裁定できる。

- [x] **P0-3 Codex親Stop hookを実測する。**
  - 成果物: 正式event名、payload、session / cwd情報、stdout / stderr / exit codeの観測記録。
  - 完了条件: boundedなJSON reasonを同じ親turnのcontinuation promptとして注入できるか、できないかを再現手順付きで裁定できる。

- [x] **P0-4 Observer継続turnを実測する。**
  - 成果物: timeout後、同じObserver turnをStop continuationで再開する候補比較と、MCP wait transport実測。
  - 完了条件: project-local Stop continuationとMCP tool callの60秒超live waitを再現し、失敗、再開、停止方法を説明できる。
  - 実測: 65秒timerのMCP呼出しがCodex上で正常完了した。サーバー計測は時計境界により64,999msだったが、60秒超のhost保持という検証目的を満たす。途中取消はtimeoutでなくMCP承認要求が原因で、read-only注釈と対象tool限定の明示許可が必要。

- [x] **P0-5 v1実装契約と安全網を固定する。**
  - 成果物: 採用API、state path、runtime、検証コマンド、characterization test一覧。
  - 完了条件: 未確定事項3件が解消または明示的blockedになり、反対仮説の検証を一回通過する。
  - 裁定: Throughline JSON CLI + Observer MCP adapter、macOS owner-only state、`emitted_unacked` receiptを採用。DB直接監視、Throughline本体のMCP所有、cross-platform見せかけ、Host ack見せかけを棄却した。

- [x] **P0-6 Claude親／Claude Observerのhost境界を実測する。**
  - 成果物: Claudeの完了turn証拠、正式Stop event／payload、project／session identity、60秒超wait、同じturnへのcontinuation、明示停止の再現記録。
  - 完了条件: Claude Observerと親Claudeへの配送を、Codex wireの流用や推測なしで実装できる。
  - 実測: Claude Code 2.1.207でheadless `result/end_turn`、同じsession IDのresume、`SessionStart:resume`を確認した。backgroundは`--print`非対応で、`claude --bg '<task>'`のjob handleを`agents --json`／`logs`／`stop`で回収できた。完了turnはfinal assistantやprocess exitでなく、Throughline所有のStop receiptへ束縛する。`/rewind`はforkなので同一session rollbackを新設しない。

- [x] **P0-7 Observerのprovider配置と役割を固定する。**
  - 成果物: Codex親→Codex Observer、Claude親→Claude Observerという同provider契約と、継続的反証ではない伴走者契約。
  - 完了条件: 一般Workerのrate-aware配置、異社相談役、Phase反証とObserverを文書上で分離する。

- [x] **P0-8 Observerの起動責任とlifecycleを固定する。**
  - 成果物: ユーザー明示指示、親launcher、同provider、二重起動拒否、明示停止、fault停止の契約。
  - 完了条件: 暗黙起動と自動再起動を禁止し、一target一watchの所有境界を固定する。
  - 裁定: [ADR 0002](adr/0002-explicit-parent-launch.md)。

**Gate:** P0-1〜P0-8を完了済み。Claude adapterはThroughline Stop receiptとbackground job handle契約から実装できる。

---

## Phase 1: Throughline wait依存

- [x] **P1-1 Throughline側に独立した正本プランを作る。**
  - 成果物: Throughline repoの`docs/`に置かれたcompleted-only read / wait API計画/TODO。
  - 完了条件: opaque cursor、最新thread解決、delta / switch / resync、競合窓、timeout、cancel、再接続、test、rollbackがThroughlineの所有契約として定義される。
  - 正本: `/Users/kite/Developer/Throughline/docs/14_observer_completed_turn_feed_plan.md`

- [ ] **P1-2 Throughline側の計画完遂を確認する。**
  - 成果物: `observer-wait`、`observer-read`とThroughline側test。詳細TODOはThroughline側正本で管理する。
  - 完了条件: Claude／Codex両hostでin-flight除外、即時changed、待機changed、timeout、呼出競合、thread／host switch、rollback、再起動のgateがThroughline repoでgreenになる。

- [ ] **P1-3 Observerからblack-box検証する。**
  - 成果物: Observer MCP adapterからThroughline公開CLIだけを使うcontract test。
  - 完了条件: 短縮timeout fixtureでchanged / timeout / missed-wakeup防止を再現し、Throughline実CLIを通した65秒超live callと3600秒設定が受理される。

**Gate:** ObserverがThroughlineのDB / WALへ依存せず、新規turnを失わず待てる。

---

## Phase 2: 最小Observer loop

- [x] **P2-1 Observerプロジェクトを初期化する。**
  - 成果物: runtime、package、lint、unit test、CIの最小構成。
  - 完了条件: 空実装のbaseline gateがgreenで、rollback可能な独立単位になる。
  - 実装: Node ESM / Node 22.13以上、runtime dependencyなし、Node test runner、構文検査、GitHub Actionsを追加。標準gateは`npm test && npm run check`。
  - Control証跡: `observer-scaffold-run`は、初回baselineを親が同じworkspaceで確立したため`WORKSPACE_DRIFT`で失敗した。このRunを成功・acceptedへ変更しない。P2-1の完了根拠は親が独立に検証した16 test greenとroot commit `7b699c8`であり、Task `observer-scaffold`だけを本項参照でfinalizeする。

- [x] **P2-2 project target登録を実装する。**
  - 成果物: canonical project resolver、`observer target register <absolute-project-root>`、Observer所有state。
  - 完了条件: 同じprojectを安定したtargetへ解決し、別projectと混同せず、working treeを汚さない。
  - 実装: canonical pathのSHA-256からtarget IDを生成し、macOSの中央stateへ0700/0600でatomic登録する。相対path、symlink state、不正permission、非macOS defaultをfail closedで拒否する。

- [x] **P2-3 最新親スレッド解決を実装する。**
  - 成果物: Throughlineのhost-bound確定turn時刻から現在親とhostを選ぶresolver。
  - 完了条件: 親AからBへのthread切替と、Claude／Codex間のhost切替fixtureで、Bの最初の確定turn後にだけ追跡先がBへ切り替わる。複数活動親はfail closedにする。
  - v1境界: [ADR 0001](adr/0001-parent-resolution-boundary.md)。一般的なactive leaseをmtime／PID／TTLで
    推測せず、一project一活動親を前提にする。Throughlineが返す`ambiguous_parent`はfail closedにする。
  - 実装: hash-only parent state、snapshot／delta／thread／host切替、cursor連結、pagination transaction、
    `projection_pending`／`ambiguous_parent`／`resync_required`のfail-closed境界を実装した。
  - 検証: `node --test test/parent-resolver.test.mjs` 5/5 PASS。commit `91e51bd`、Control revision 8。

- [ ] **P2-4 一時間wait loopとcursor回復を実装する。**
  - 成果物: host-neutralな`observer watch <absolute-project-root>`、active watch transaction、親別launcherと、Claude／Codex adapterでchanged / timeout / restartを処理する監視loop。
  - 完了条件: ユーザー明示指示を受けた親だけが同provider Observerを一体起動する。timeout時は定型報告だけでDoneし、同じturn内の次監視サイクルで同じcursorから再待機し、停止中の更新も回収する。二重起動、transport / schema / state failureではfail closedまたはfaultedになり、takeover、自動再起動、Stop continuationを繰り返さない。
  - [x] Throughline公開CLI clientと、cursorをまだ保存しない一監視cycleを実装する（[ADR 0003](adr/0003-throughline-subprocess-cycle.md)）。
    - bounded JSON、UTF-8 byte収集、strict schema、Abort時のSIGTERM→SIGKILL terminal cleanup、
      orientation／timeout／fixed-through pagination／projection pendingを実装した。
    - 検証: `node --test test/throughline-client.test.mjs test/watch-cycle.test.mjs` 9/9 PASS。
      commit `f3bfef1`、Control packet `e4cf0531…2cc8`、revision 17。
  - [x] `projection_pending` bounded retry、監査後のcursor atomic commit、crash recoveryを実装する（[ADR 0005](adr/0005-supervisor-cycle-commit.md)）。
    - [x] `prepared → processed → cursor commit → cleanup`のjournal store、full-state CAS、crash recoveryを実装した。
      検証: `node --test test/cycle-store.test.mjs` 5/5 PASS。commit `845c002`、Control revision 19。
    - [x] watch cycle、bounded retry、監査callback、journal recoveryをSupervisorへ配線した。
      通常changedとprepared recoveryのどちらも最初のfixed-through cursorから範囲を拡張せず、
      durable callback結果の検証後だけ`processed`保存とcursor commitを行う。
      検証: `node --test test/watch-cycle.test.mjs test/supervisor-cycle.test.mjs` 12/12 PASS。
      commit `181a54e`、Control packet `b29a9761…65fe`、revision 26。
  - [x] 一target一active watch transactionと明示stopを実装する（[ADR 0004](adr/0004-active-watch-transaction.md)）。
    - provider child前の`starting`予約、二重起動拒否、watch ID CAS、private handle非公開、
      `active → stopping → stopped`、fault、明示nonce lock回復を実装した。
    - 検証: `node --test test/watch-store.test.mjs` 7/7 PASS。commit `e0a1843`、Control revision 14。
  - [ ] Codex／Claude親launcherと同provider child lifecycleを実装する（[ADR 0006](adr/0006-parent-owned-provider-launch.md)、起動順序の訂正=[ADR 0007](adr/0007-durable-launch-handle-before-start.md)）。
    - [x] explicit authorization、`starting → launching → active`、private provider handle、相関付きstop／fault transactionを実装した。
      検証: `node --test test/parent-launch.test.mjs test/watch-store.test.mjs` 16/16 PASS、cycle-store fixture 5/5 PASS。
      commits `1ed545c`、`ed4f077`、Control revision 32。
    - [x] unrestricted Codex親ではcustom agentの`read-only`が実効sandboxにならないことを実測し、native Observerを禁止した（[ADR 0008](adr/0008-codex-readonly-host-boundary.md)）。
    - [ ] Codex persistent app-server thread候補／Claude backgroundの親host adapter、同provider Observer role、routing検証を実装する。
      P2-5のread-only強制がgreenになるまでlive childは起動しない。

- [ ] **P2-5 read-only境界を強制する。**
  - 成果物: project read-only、Observer state / Mailbox write-onlyの実行profileと拒否test。
  - 完了条件: project内writeが失敗し、監視とMailbox publishは成功する。
  - [x] Codex native custom agentのTOML指定だけではunrestricted親のoverrideを防げないことを実測した。
  - [x] app-server persistent threadのper-thread read-only、project write拒否、別processからの`thread/read`／`thread/list`回収をcharacterizationした（[ADR 0009](adr/0009-codex-appserver-characterization.md)）。
  - [ ] Codexアプリ内表示、65秒超wait、adapter crash後のturn resume、明示interrupt／停止、Observer MCP限定writeをcharacterizationする。
  - [ ] Claude backgroundをread-only tool allowlistで起動し、project write拒否とObserver MCP成功をcharacterizationする。

**Gate:** 手紙を生成しない最小Observerが、親の再作成と一時間timeoutを含めて継続監視できる。

---

## Phase 3: Mailboxと親Stop hook

- [x] **P3-1 中央Mailboxの保存・publish契約を実装する。**
  - 成果物: project別inbox、message schema、atomic publish、permission / size / digest検査。
  - 完了条件: 不正messageを拒否し、正常messageを部分書込なしで公開できる。
  - 実装: strict schema、canonical digest、byte上限、secret pattern拒否、同一message ID拒否、同一filesystem上の完全書込み後publishを実装した。

- [x] **P3-2 consume transactionを実装する。**
  - 成果物: atomic claim、本文削除、digest-only receipt、`delivery_unknown`、retention。
  - 完了条件: concurrent consumerとfault injectionで同一本文を二重配送しない。
  - [x] consumer lock、inbox→processingのatomic claim、`claimed`→`emitted_unacked` receipt、本文削除を実装する。
  - [x] claim後crashを明示的に`delivery_unknown`へ回収し、再配送しない。
  - [x] malformed messageを注入せず、本文なし`invalid` receiptへ変える。
  - [x] 完了receiptを30日・最大1000件へbounded化し、`claimed`は自動削除しない。
  - [x] lock owner nonceの観測と一致確認を必須にする明示recoveryを実装する。
  - [x] claim後crash、malformed本文、重複publish、concurrent consumerの代表faultをtestで再現する。

- [ ] **P3-3 誤配送防止を実装する。**
  - 成果物: project target、観測host、thread IDによるrouting、旧thread／旧host手紙の失効処理。
  - 完了条件: 別project、旧thread、target不明ではclaimせず、現在project / threadだけが取得できる。
  - [x] projectごとの物理inbox分離と、target / thread完全一致時だけのclaimを実装する。
  - [ ] 親Stop payloadからのcurrent target解決、旧thread messageの失効receiptを実装する。

- [ ] **P3-4 親Stop hook adapterを実装する。**
  - 成果物: Claude／Codex別のMailbox fast path、bounded advisory render、installer / verify / rollback。
  - 完了条件: 両hostでMailboxなしなら短時間で終了し、一件の手紙を同じ親turnへ一度だけ正式なcontinuation promptとして注入できる。

**Gate:** 手動publishした手紙が正しい親へ最大一回だけ届き、本文が残らない。

---

## Phase 4: Observer AIとノイズ抑制

- [ ] **P4-1 Observer起動契約と出力schemaを実装する。**
  - 成果物: 親と同じproviderを選ぶhost resolver、read-only伴走者役割、禁止事項、`no_advisory` / advisory proposalの固定契約。
  - 完了条件: 異provider Observer、継続的反証、通常会話、実装、自由形式出力へ逸脱した結果をSupervisorが拒否する。

- [ ] **P4-2 bounded evidence収集を実装する。**
  - 成果物: 新規turn、plan、diff、git、test evidenceの最小snapshot。
  - 完了条件: prompt全文、secret、巨大logを保存せず、手紙のclaimを検証できる参照を作れる。

- [ ] **P4-3 過剰指摘抑制を実装する。**
  - 成果物: materiality、evidence、novelty、actionability、timing gateとdedupe / cooldown。
  - 完了条件: 好み、一般論、証拠不足、対処中、同一指摘のfixtureで手紙を出さない。

- [ ] **P4-4 severityと最小dogfoodを完了する。**
  - 成果物: `info`、`warning`、`review_required`の実例と採否記録。
  - 完了条件: 正常進行では沈黙し、有益な助言とソフトストップを各一回だけ配送できる。

**Gate:** Observerが親の仕事を奪わず、ノイズより価値の高い助言だけを送る。

---

## Phase 5: 統合、監査、還流

- [ ] **P5-1 E2Eとfault injectionを完了する。**
  - 成果物: Codex `task_complete`／Claude実証済み完了証拠 → Throughline → 同provider Observer → Mailbox → 親Stop continuationの両host統合test。
  - 完了条件: timeout、thread切替、crash、重複通知、誤配送、claim失敗を含む受け入れ条件がgreenになる。

- [ ] **P5-2 性能、導入、rollbackを確定する。**
  - 成果物: latency実測、installer、verify、runbook、cleanup、rollback。
  - 完了条件: 空Mailboxと通常waitが開発体験を阻害せず、clean環境で導入・撤去を再現できる。

- [ ] **P5-3 最終監査とknowledge returnを完了する。**
  - 成果物: Find → Dedup → 反証 → Critic → 親裁定、RAG / caveat / docsへの還流記録。
  - 完了条件: P0/P1問題が残らず、全受け入れ条件を親が裁定し、本プランをarchiveできる。

---

## v1受け入れ条件

1. projectの絶対パスだけで監視を開始でき、Claude／Codexの親スレッド再作成へ自動追従する。
2. Codexの`task_complete`またはClaudeの実証済み完了証拠だけでhost-bound completed cursorが進み、Observer MCP adapterから呼ばれた最大一時間のThroughline wait中のObserverを起こす。
3. timeout時はObserver自身へ待機継続を一言残し、各hostのproject-local Stop continuationで同じcursorから自動再待機する。
4. crash、timeout境界、重複通知があっても確定turnを失わず、同じturnを二重監査しない。
5. ObserverはprojectとThroughlineをread-onlyで扱い、実装、停止、Task変更を行えない。
6. Observerは親と同じprovider familyで動き、正常進行では沈黙し、証拠、重要性、行動可能性のある助言だけを送る。継続的な反証役にならない。
7. 別project、旧thread、不正messageを配送せず、正しい手紙を親へ最大一回だけ注入する。
8. 配送後は本文を削除し、boundedなdigest-only receiptだけを残す。
9. Claude／Codexの親Stop hook adapterはMailboxなしで高速に終了し、外部LLM、network、long-pollへ同期依存しない。
10. E2E、fault injection、installer、verify、rollback、full CI、最終監査、knowledge returnが完了する。
11. 利用者の明示指示を受けた親だけが同provider Observerを起動し、一targetで二重起動しない。
