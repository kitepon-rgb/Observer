# Observer v1 実装計画

**Status:** Active — Claude／Codex両host対応と実Throughline CLI統合を進行中

**作成日:** 2026-07-14

**製品契約:** [00_product-contract.md](00_product-contract.md)

この文書は作業の現在地だけを管理する。製品仕様、非目標、廃案、恒久規約は製品契約または`AGENTS.md`を正とする。

---

## 未確定事項

completed-turn境界の初期未確定事項は解消済み。Claude側の完了証拠、Stop hook、60秒超wait、continuation、停止方法はP0-6で実測し、Codexの挙動から推測しない。Codex native childのread-only不成立はP2-5 blockerとして[ADR 0008](adr/0008-codex-readonly-host-boundary.md)で分離する。

---

## Throughline変更裁定

- 当初のThroughline変更holdは、オーナーの続行指示により解除済み。
- Throughline側は自身の`docs/14_observer_completed_turn_feed_plan.md`、独立Control、独立gate、独立commitで進める。
- Observerは公開`observer-read`／`observer-wait` CLIだけを利用し、ThroughlineのDB／WAL／libraryへ依存しない。

## Control wave

- foundation wave `observer-independent-foundation-20260714`はbounded worker budgetを使い切ったため、
  [ADR 0016](adr/0016-control-wave-boundary.md)の受入表でarchiveし、Codex host adapter以降を
  `observer-codex-host-runtime-20260715`へ継続する。これはObserver全体またはPhase 2の完了宣言ではない。
- Control finalizationのdigest証拠には可変な本planを使わず、immutable ADRを使う。

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

- [ ] **P0-6 Claude親／Claude Observerのhost境界を実測する。**
  - 成果物: Claudeの完了turn証拠、正式Stop event／payload、project／session identity、60秒超wait、同じturnへのcontinuation、明示停止の再現記録。
  - 完了条件: Claude Observerと親Claudeへの配送を、Codex wireの流用や推測なしで実装できる。
  - 部分実測: Claude Code 2.1.207でheadless `result/end_turn`、同じsession IDのresume、`SessionStart:resume`を確認した。2.1.210ではbackground jobが75秒まで`working`を維持し、90秒timer中の実行中stop、子process消滅、project fingerprint不変を確認した（[ADR 0011](adr/0011-claude-process-boundary-characterization.md)）。daemon／adapter crash後の結果回収は未検証。完了turnはfinal assistantやprocess exitでなく、Throughline所有のStop receiptへ束縛する。`/rewind`はforkなので同一session rollbackを新設しない。

- [x] **P0-7 Observerのprovider配置と役割を固定する。**
  - 成果物: Codex親→Codex Observer、Claude親→Claude Observerという同provider契約と、継続的反証ではない伴走者契約。
  - 完了条件: 一般Workerのrate-aware配置、異社相談役、Phase反証とObserverを文書上で分離する。

- [x] **P0-8 Observerの起動責任とlifecycleを固定する。**
  - 成果物: ユーザー明示指示、親launcher、同provider、二重起動拒否、明示停止、fault停止の契約。
  - 完了条件: 暗黙起動と自動再起動を禁止し、一target一watchの所有境界を固定する。
  - 裁定: [ADR 0002](adr/0002-explicit-parent-launch.md)。親session単位の論理Observerとcontext generationへの
    更新は[ADR 0025](adr/0025-parent-session-observer-generation.md)を正とする。

- [x] **P0-9 Observer repoへCodegraph project indexを導入する。**
  - 発見経路: provider binding計画の構造調査で、CLI／MCP登録は済んでいる一方、Observer固有の
    `.codegraph/`が未初期化だったため構造queryを利用できなかった。
  - 成果物: upstream正規入口`codegraph init`が生成する、共有可能な設定と端末local index。
  - 完了条件: `codegraph status --json`が`initialized=true`、対象projectがObserver root、
    `pendingChanges`が空、SQLite journalが`wal`を返し、生成された設定だけが追跡候補になる。
  - rollback: `codegraph uninit`でObserver固有の`.codegraph/`だけを除去する。
  - 実測: Codegraph 1.4.1で60 files、1,339 nodes、5,603 edgesをindex化した。statusは
    `initialized=true`、`journalMode=wal`、`pendingChanges=0`、`reindexRecommended=false`。
    provider bindingの構造探索も実sourceとblast radiusを返した。DBは`.codegraph/.gitignore`により
    端末local、生成されたignore metadataだけを追跡候補にする。

**Gate:** P0-6のdaemon／adapter crash後の結果回収が未完。host-neutral coreは先行できるが、Claude live adapterのproduction採用はblockedのまま維持する。

---

## Phase 1: Throughline wait依存

- [x] **P1-1 Throughline側に独立した正本プランを作る。**
  - 成果物: Throughline repoの`docs/`に置かれたcompleted-only read / wait API計画/TODO。
  - 完了条件: opaque cursor、最新thread解決、delta / switch / resync、競合窓、timeout、cancel、再接続、test、rollbackがThroughlineの所有契約として定義される。
  - 正本: `/Users/kite/Developer/Throughline/docs/14_observer_completed_turn_feed_plan.md`

- [ ] **P1-2 Throughline側の計画完遂を確認する。**
  - 成果物: `observer-wait`、`observer-read`とThroughline側test。詳細TODOはThroughline側正本で管理する。
  - 完了条件: Claude／Codex両hostでin-flight除外、即時changed、待機changed、timeout、呼出競合、thread／host switch、rollback、再起動のgateがThroughline repoでgreenになる。

- [x] **P1-3 Observerからblack-box検証する。**
  - 成果物: Observer MCP adapterからThroughline公開CLIだけを使うcontract test。
  - 完了条件: 短縮timeout fixtureでchanged / timeout / missed-wakeup防止を再現し、Throughline実CLIを通した65秒超live callと3600秒設定が受理される。
  - [x] `test/throughline-black-box.integration.mjs`から実Throughline CLIだけを起動し、待機中changed、
    1秒timeout、呼出前completionの即時changed、DB未projection時の`projection_pending`を2.27秒で固定した。
    Throughline側の隔離HOME black-boxで65秒超live changedと3600秒設定は確認済み。Control revision 49で親受入済み。
  - [x] Observer MCP adapterを実装し、同じblack-box境界をMCP tool wireから通す。
    - MCP 2025-11-25／2025-06-18のinitialize、固定`observer_read`／`observer_wait`、active watch identity、
      structured/text result、cancel／stdin shutdown、stdout衛生を[ADR 0013](adr/0013-observer-mcp-stdio-contract.md)へ固定した。
      `node --test test/mcp-server.test.mjs test/throughline-client.test.mjs`は10/10 PASS。

- [x] **P1-4 標準testと実Throughline統合testの実行境界を分離する。**
  - 成果物: 外部CLIなしでgreenになる標準`npm test`と、実CLI pathを明示してfail loudに実行する統合test script。
  - 完了条件: 標準gateが統合testをskip扱いで隠さず除外し、明示統合gateでは既存black-box 1件が実Throughline CLIでPASSする。

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
  - 完了条件: ユーザー明示指示を受けた親だけが同provider Observerを一体起動する。外部Supervisorが一target一processで
    wait／read／cursor／model operation／applyを所有し、timeoutではAIを起動せず同じcursorから次のbounded wait stepへ戻る。
    二重起動、transport / schema / state failureではfail closedまたはfaultedになり、takeover、自動再起動、provider request再送を行わない。
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
      - [x] 全hostの`cwd`をcanonicalなObserver rootへ固定し、target `project_root`をhost cwdや擬似projectへ使わない製品identityを固定した（[ADR 0017](adr/0017-observer-project-identity.md)）。
        - `AGENTS.md`を両host共通の静的Observer契約、`CLAUDE.md`をClaude固有差分の入口にする。
        - watchごとにthread／jobは分けても、監視対象ごとのtemporary repo／アプリprojectを生成しない。
        - 実行時契約は検証済みchild start envelopeの時だけ発火し、Observer開発AIの権限と分離する。
        - Codex app／Claude UI表示と既存の不要project cleanupは未検証のH gateとして残す。
      Claude backgroundはexact tool allowlistでproject readとwrite拒否、job handleの`working → done`、同handle stopを実証した。
      argvの可変長flag順序とterminal後のlogs回収不能を[ADR 0010](adr/0010-claude-background-readonly-characterization.md)でadapter契約へ固定した。
      - [x] Claude adapterの純粋coreとして、絶対CLI path、固定prompt位置、Observer MCPのruntime-root字句境界、公開／無人許可の分離、
        job相関、terminal先行stop、raw出力非保持を実装した（[ADR 0012](adr/0012-claude-host-adapter-contract.md)）。
        検証: `node --test test/claude-host-adapter.test.mjs test/parent-launch.test.mjs` 14/14 PASS。
      - [x] 実行層でClaude CLI／Observer MCP executableのrealpath・version・所有を検証し、spawn／observe／stopをparent-launchへ配線する。
        `src/claude-host-runtime.mjs`でmanifest固定path、file identity／digest、Claude 2.1.210、MCP 0.0.0、
        exact tool surfaceを検証し、handle先行耐久化を守る分離runtimeを実装した（[ADR 0015](adr/0015-claude-host-runtime-boundary.md)）。
        - Claude `--bg`のshort IDをspawn直後に耐久化し、observe／readyを同じ関数へ畳み込まない。
        - MCP tool surfaceは実装済みの`observer_read`／`observer_wait`だけへexact固定し、wildcardを許さない。
        - [x] [ADR 0060](adr/0060-supervisor-owned-cycle-runtime.md)の所有権訂正によりproduction Observer AIの
          tool allowlistを空へ変更した。MCP server自体は削除せず、compatibility／diagnostics裁定を後続Taskへ残した。
          - [x] `claude-host-runtime`の旧MCP allowlist期待を空surface契約へ揃えた。commit `d34b119`、
            失敗scopeのfocused 1/1がgreen。直前関連gateの他65件は同じproduct filesでgreenだったため再利用し、66/66へ収束した。
        - spawn結果不明時はwatch固有nameとcwdから回収し、同じwatchを再spawnしない。
        - 検証: focused 23件、parent-launch接続7件、`npm run check`、実binary read-only diagnosticsがgreen。
      - [x] Codex app-serverの純粋adapterとsession runtimeをparent-launchへ配線した（[ADR 0018](adr/0018-codex-host-runtime-boundary.md)）。
        - `thread/start`結果不明は同一cwdの候補へattachせず`thread_start_unknown`、`turn/start`結果不明は
          `turn_start_unknown`として耐久化し、同じwatch／cycleの再実行を拒否する。
        - thread IDをwatch handle、turn IDを別operation journalへ保存し、親stateへthread handleを耐久化してからだけ
          `turn/start`する。`thread/read`と`thread/resume`をterminal照合／継続購読に分離する。
        - interrupt ACKではwatchを閉じず、同じthread／turnのterminal receiptをparent-launchで必須化した。
          interrupt結果不明でも送信前に`stopping`を耐久化し、同じturnへ再送しない。
        - focused gate: `node --test test/codex-host-adapter.test.mjs test/codex-host-runtime.test.mjs test/parent-launch.test.mjs` — 23/23 PASS。
        - app-server process transport、実model turn、UI、65秒超wait、crash後のunknown reconciliation、Observer MCP限定writeは
          未検証のH／後続gateであり、production採用済みとはしない。
      - [x] Codex app-serverのbounded JSONL process transportを実装した（[ADR 0019](adr/0019-codex-process-transport.md)）。
        - Codex executable identityとversionをObserver rootで確認し、`codex app-server`をshellなし・環境allowlistで生成する。
        - request IDとresponseをexact相関し、未知／重複ID、oversize／不正JSONL、stderr／process終了をfail closedにする。
        - pending requestの切断は成功や自動retryへ丸めずunknownとして返し、同じlogical operationの再実行判断は
          `codex-host-runtime`のdurable journalへ委ねる。
        - fake child processのfocused testだけをこのTODOのgateとし、実Codex process／model turnは起動しない。
        - focused gate: `node --test test/codex-process-transport.test.mjs test/codex-host-runtime.test.mjs` — 15/15 PASS。
      - [ ] parent session epochごとに一論理Observerを束縛し、同epoch内のcontext budget到達では
        一つの物理host generationだけをterminal確認付きで世代交代する。
        - watch authorizationは維持し、新しいwatchやtarget別projectを生成しない。
        - [x] generation counter、completed cycle count、累積bounded input bytesを独立durable stateに持ち、
          8 completed cycle／262,144 model-visible UTF-8 bytesのhard thresholdとmodel前reservationを固定した
          （[ADR 0034](adr/0034-generation-budget-and-planned-rollover.md)、[ADR 0035](adr/0035-generation-state-store-acceptance.md)）。
        - [x] cycle pending v2、input reservation、cursor／generation commitをexact-once接続し、各write間の
          crash recoveryと非永続inputを固定した（[ADR 0036](adr/0036-cycle-generation-exact-once-transaction.md)、
          [ADR 0037](adr/0037-cycle-generation-exact-once-acceptance.md)）。
        - cursor、dedupe／cooldown receipt、boundedな未解決仮説だけを引き継ぎ、raw会話／tool logは保存しない。
        - [x] watch継続の短命host journal、旧terminal確認、旧→新handle CAS、ready後activation、
          Codex generation namespace、Claude live候補限定をfake fixtureで実装した
          （[ADR 0038](adr/0038-generation-host-rollover-transaction.md)、
          [ADR 0040](adr/0040-generation-host-rollover-core-acceptance.md)）。
        - [ ] 上記record-first coreをClaude／Codex固有のterminal stop／次generation start commandへ接続する。
          - [x] raw handleを出さないrecovery contextと、watchを再遷移させないCodex generation runtimeを先行実装した
            （[ADR 0042](adr/0042-generation-provider-binding-recovery-contract.md)、
            [ADR 0043](adr/0043-generation-recovery-surface-acceptance.md)）。
          - [x] recovery contextを使うClaude／Codex provider bindingを、一command一stepで実装する
            （[ADR 0044](adr/0044-generation-provider-binding-step-contract.md)）。
            - [x] Codexの再送なしterminal観測APIを実装する。
              - commit `b06a847`。同一generationのdurable thread／turnだけをread-only照合し、
                terminal／pending／unknownとraw-free receiptを返す。
            - [x] host-neutral provider binding step machineを実装する。
              - commit `02329ad`。一call一provider mutation、stop再送なし、provider ready後の
                core spawn／ready適用、unknown fail-closedを固定した。
            - [x] 隔離した2 Workerの成果を本線へ統合し、focused gateを通す。
              - 関連gate 46/46、`npm run check`、`git diff --check`成功。両TaskはControl revision 29までに
                [ADR 0046](adr/0046-generation-provider-binding-step-acceptance.md)でfinalizeした。
          - [ ] model request送信結果不明をhost lifecycleと別journalで回収する
            （[ADR 0047](adr/0047-model-operation-journal-contract.md)）。
            - [x] generation reservationより先にhost-neutral model operationを`prepared`で耐久化し、
              `prepared -> reserved -> dispatching -> accepted -> completed -> applied`の一方向遷移と
              identity conflictを実装する。
              - commit `4c3cc03`。exact cycle result、UTC時刻非後退、private path／lock、status限定cleanupまで
                focused 8/8で固定し、[ADR 0049](adr/0049-model-operation-store-core-acceptance.md)で受け入れた。
              - [x] Supervisor統合前の独立反証で見つかったlock残留、completed result locator、planned rollover、
                processed前cleanupの4件を[ADR 0051](adr/0051-model-operation-recovery-invariant-corrections.md)どおりcorrective実装する。
                - commit `8afebca`。same／next generationのprepared回収を含むfocused＋related 27/27、
                  `npm run check`、scoped diff-checkを通し、
                  [ADR 0053](adr/0053-model-operation-recovery-corrections-acceptance.md)で受け入れた。
            - [x] Supervisorを`issue_once`／`recover_only`／idempotent applyへ分け、`dispatching`からmodel requestを
              再送せず、strict parse済みcanonical AI outputだけをcycle processedへ移管する
              （[ADR 0050](adr/0050-supervisor-model-operation-integration-contract.md)）。
              - commit `c226cc9`。focused 15/15、関連gate 47/47、`npm run check`、scoped diff-checkを通し、
                [ADR 0054](adr/0054-supervisor-model-operation-integration-acceptance.md)で受け入れた。
            - [x] prepared／reservation／provider handle／canonical result／apply／processed／cleanup間の
              crash matrixをfocused fixtureで固定する。
            - [ ] Claude／Codexのexact operation result readをprovider固有journalへ実装し、handle欠損を
              別operationへの再送で隠さない（[ADR 0055](adr/0055-provider-exact-result-journal-contract.md)）。
              - Codexは保存済みthread／cycle turnの`thread/read`だけからexact `agentMessage` itemを再読する。
                Claudeはjob／sessionを
                束縛した`Stop.last_assistant_message`をhook中にcanonical保存する。
              - `logs`／transcript／private provider state／別turn／別job／新規requestへのfallbackを禁止する。
              - provider journal coreとfake public-surface fixtureを先に受け入れるが、この時点では本TODOを閉じない。
                現行profileへObserver所有hookだけを注入するhost adapter接続、Codex item baseline、
                両host session／turn相関、Supervisorの`complete -> provider cleanup -> apply`を続けて実装する。
                - [x] provider journal coreをcommit `4443ff9`で追加し、両host合計focused 10/10を通して
                  [ADR 0056](adr/0056-provider-result-journal-core-acceptance.md)で受け入れた。
                - [x] Supervisorを`completeModelOperation -> cleanupProviderOperation -> applyCycle`へ接続し、
                  generic completed recoveryとcleanup fail-closedをcommit `3600876`、focused 26/26、
                  [ADR 0057](adr/0057-supervisor-provider-cleanup-acceptance.md)で固定した。
              - Claude job `sessionId`／Stop `session_id`の一致、Codex hook trustとin-progress item再読はlive H gateで
                version固定し、未実証をproduction対応済みにしない。
              - [x] **SUPERSEDED:** host-neutral canonical cycle requestとCodexの
                `thread/read baseline -> turn/steer -> ACK -> accepted journal` fixtureをcommit `1bb7b07`、
                focused 22/22、Supervisor関連16/16、[ADR 0059](adr/0059-codex-cycle-request-delivery-acceptance.md)で
                受け入れたが、AI wait loopとSupervisorの二重所有およびStop idle問題が判明したため、
                [ADR 0060](adr/0060-supervisor-owned-cycle-runtime.md)で`turn/steer`／Stop continuation部分をsupersedeした。
                canonical requestとprovider journal欠損補正は維持する。
              - [x] 外部Supervisor単一所有とCodexの
                `thread/read context -> cycle turn/start -> ACK -> accepted journal`をcommit `3f35dbb`でcorrective実装した。
                focused 38/38、Supervisor関連16/16、static gateを通し、
                [ADR 0061](adr/0061-supervisor-owned-cycle-core-acceptance.md)で受け入れた。
              - [ ] Codex production Supervisor callerを接続し、cycleごとのsession／turn／exact result順序をlive H gateで固定する。
                - [x] `applyCycle`／`finalizeAppliedCycle`のproduction callbackをcommit `fc51157`で実装し、durable
                  operation時刻とcanonical cycle inputからadvisory messageを決定的に再構成してMailbox exact replay／
                  cleanupへ接続した。focused 4/4、関連40/40、static gateを通し、
                  [ADR 0063](adr/0063-cycle-application-callback-acceptance.md)で受け入れた。
                - [x] 一target一process lock、evidence input、Codex provider callback、sanitized production receiptを
                  束ねる一step callerをcommit `0ca7abe`で実装した。focused 4/4、関連44/44、static gateを通し、
                  [ADR 0065](adr/0065-supervisor-production-step-acceptance.md)で受け入れた。
                - [x] verified Throughline clientとpre-initialized Codex app-server sessionを所有する外部process／CLIへ
                  一step coreを配線し、timeout／cancel／fault／explicit stop loopを固定する。
                  - [x] target固有process lease、active watch停止監視、timeout／model pendingのbounded反復を
                    host-neutral process loopとして実装する。
                    `model_result_unknown`は回収不能なterminal faultとしてpollせず停止する（[ADR 0067](adr/0067-model-result-unknown-is-terminal.md)）。
                  - [x] Throughline executableとCodex app-serverを一process内で検証・初期化し、終了時にCodex childの
                    terminal確認を必須化する。子process残存や終了不明を成功へ丸めない。
                    app-server faultは進行中Throughline waitへ即時伝播する（[ADR 0068](adr/0068-provider-process-fault-cancels-wait.md)）。
                  - [x] `observer supervisor run` CLIをabsolute command／watch identity／Observer rootへ束縛し、
                    signal cancel、explicit stop、faultのJSON／exit contractをfocused fixtureで固定する。
                  - [x] focused／related gateを通し、[ADR 0069](adr/0069-supervisor-process-cli-acceptance.md)と
                    独立commitへ固定する。corrective変更後の最終関連gateは70/70、static gateはgreen。
              - [ ] Claude background jobへの公開非対話reply ACKと隔離`--settings` Stop hookをlive H gateで実証して接続する。
            - [x] Mailbox publishをdeterministic message IDの同内容replayだけ冪等成功にし、異内容をconflictにする
              （[ADR 0048](adr/0048-mailbox-operation-publish-replay-contract.md)）。
              - 既存`publishMessage`のduplicate拒否は維持し、model operation専用`publishOperationMessage`と
                raw-freeな`publish-receipts/`を追加する。
              - receiptを`prepared`でrecord-first作成し、inbox／processing／consumer receiptからexact digestを回収する。
              - model journalの`applied`後だけpublish receiptをcleanupし、それまでは対応するconsumer receiptをretention対象外にする。
              - commit `0e7a005`。focused 15/15、`npm run check`、scoped diff-checkを通し、
                [ADR 0052](adr/0052-mailbox-operation-publish-replay-acceptance.md)で受け入れた。
        - [ ] parent rebind、planned rollover、fault recoveryを別transition／receiptにして統合する。
          - [x] planned rolloverを既存generation host journal／provider bindingから
            Supervisor processへ接続し、同じverified runtimeで一stepずつ回収して
            新generation activation後にprepared cycleへ戻る
            （[ADR 0070](adr/0070-supervisor-planned-rollover-integration.md)）。
            - 実装commit `2bfc09c`。focused 43/43、関連gate 103/103、`npm run check`、
              `git diff --check`を通し、[ADR 0071](adr/0071-supervisor-planned-rollover-acceptance.md)で受け入れた。
              実provider commandのH受入はPhase O2 gateへ残す。
            - [x] Codex terminal観測時にraw-free receiptをhost terminalへ再構成せず、
              already-terminal stop経路のexact receiptだけをcoreへ渡す
              （[ADR 0080](adr/0080-codex-rollover-terminal-receipt-correction.md)）。
              - 補正前focused 4/5で`E_PARENT_HOST_RECEIPT`を再現し、commit `fe4f743`で修正した。
                focused 6/6、`npm run check`、`git diff --check`を通し、
                [ADR 0081](adr/0081-codex-rollover-terminal-receipt-acceptance.md)で受け入れた。
          - [ ] parent epoch切替を旧generationへのmodel requestなしで明示
            `rebind_required` transition／receiptへ記録し、parent authorizationと
            terminal確認後だけ新epochを開始する（[ADR 0072](adr/0072-parent-epoch-rebind-transaction.md)）。
            - [x] host-neutral rebind transaction、new epoch generation、watch provider／handle CASを実装する。
              - commit `426f8b9`。focused 21/21、関連gate 83/83、`npm run check`、
                `git diff --check`を通し、[ADR 0073](adr/0073-parent-epoch-rebind-core-acceptance.md)で受け入れた。
            - [x] Claude／Codex provider bindingを一command一stepで接続した
              （[ADR 0075](adr/0075-parent-rebind-provider-binding-acceptance.md)）。
              - [x] provider recovery contextをauthorization／launch request digestへ再束縛し、
                Codex turn-start unknown再送と不完全terminal receiptを補正する
                （[ADR 0074](adr/0074-parent-rebind-recovery-context-correction.md)）。
                core correction `d7ebdbb`、provider binding `3a737ad`。focused 6/6、関連66/66、
                `npm run check`、`git diff --cached --check`がgreen。
            - [x] Supervisor processへ接続し、new epoch activation後にprepared cycleへ戻る
              （[ADR 0076](adr/0076-supervisor-parent-rebind-integration.md)、
              [ADR 0077](adr/0077-supervisor-parent-rebind-acceptance.md)）。
              実装commit `107d2ca`。focused 33/33、関連122/122、`npm run check`、`git diff --check`がgreen。
            - [ ] 実thread／host switchとcrash recoveryをPhase O2 H gateで受け入れる。
          - [x] watch／provider faultをterminal確認済みのfault transition／receiptへ記録し、
            unknown outcomeを自動restart、takeover、別handle探索で隠さない
            （[ADR 0078](adr/0078-generation-fault-transaction.md)）。
            - [x] host-neutral generation fault journal／専用transitionを実装する。
            - [x] Claude／Codexの一command一step terminal bindingを実装する。
            - [x] Supervisorへrecord-first faultとfault-first restart gateを接続する。
            - [x] focused／関連gateと静的検査を一度ずつ通し、受入ADRへ証拠を固定する。
              - design `e83970c`、implementation `22cf33a`。focused 22/22、関連107/107、
                current HEADの`npm run check`、`git diff --check`がgreen。
                [ADR 0082](adr/0082-generation-fault-transaction-acceptance.md)で受け入れ、
                実host fault／terminal／crash recoveryはPhase O2 H gateへ残す。
      P2-5のread-only強制がgreenになるまでlive childは起動しない。

- [ ] **P2-5 read-only境界を強制する。**
  - 成果物: production AIのtool surfaceを空にし、project観測とObserver state／Mailbox writeを
    外部Supervisorだけが所有する実行profileと拒否test（[ADR 0083](adr/0083-read-only-execution-profile-reconciliation.md)）。
  - 完了条件: host別live gateでproject writeが拒否され、Supervisor監視とMailbox publishは成功する。
    非H fixtureのproject fingerprint不変をlive拒否証拠へ読み替えない。
  - [x] ADR 0060によりproduction AIのThroughline／Observer MCP／Mailbox tool surfaceを空にし、
    Observer MCP `observer_read`／`observer_wait`はread-only diagnostics／compatibilityへ分離した。
    Mailbox writeは外部Supervisorの固定callbackだけが所有する。
  - [x] Codex native custom agentのTOML指定だけではunrestricted親のoverrideを防げないことを実測した。
  - [x] app-server persistent threadのper-thread read-only、project write拒否、別processからの`thread/read`／`thread/list`回収をcharacterizationした（[ADR 0009](adr/0009-codex-appserver-characterization.md)）。
  - [x] **非H:** Claude exact-empty tool surface／既存隔離flagとCodex runtime-root read-only envelopeを固定し、
    同じSupervisor cycleでHEAD／index／tracked・untracked／modeを含むproject fingerprint不変と
    Observer state root配下のMailbox publish成功をfixture化する。
    commit `2168199`。focused 3/3、関連60/60、`npm run check`を通し、
    [ADR 0084](adr/0084-read-only-execution-profile-fixture-acceptance.md)で非H部分だけを受け入れた。
  - [ ] **Codex live H:** アプリ内表示、65秒超turn、adapter crash後のturn resume、明示interrupt／停止、
    project write拒否をcharacterizationする。
  - [x] Claude backgroundを`Read,Grep,Glob`だけで起動し、組込みtool surface上のproject read成功、Write tool不在による一回のwrite拒否、公開job lifecycleをcharacterizationした（[ADR 0010](adr/0010-claude-background-readonly-characterization.md)）。
  - [x] 空のsetting sources、skills／Chrome無効、strict MCPの一試行で、HEAD、index、tracked／untracked、modeを含むproject fingerprint不変をcharacterizationした（[ADR 0011](adr/0011-claude-process-boundary-characterization.md)）。
  - [x] Claude backgroundの65秒超継続、実行中stop、子process消滅をcharacterizationした。MCPは`--tools`による公開と`--allowedTools`による無人許可を分離する。
  - [x] Claude adapter coreをADR 0060でexact-empty tool surfaceへ補正し、raw agent list／stop stderrを
    構造化receiptへ保持しないことを固定した。ADR 0012の`Read,Grep,Glob`／`mcp__observer__*` allowlistはsuperseded。
  - [ ] **Claude live H:** `--safe-mode`と公開background agent定義、認証維持、隔離`--settings` Stop hook、
    project write拒否、再stop receipt、daemon／adapter crash後のterminal result回収をcharacterizationする。
    `--bare`はOAuth／keychainを無効化するため隔離fallbackにしない。
    即時完了、terminal直前crash、実行中restart、daemon消失、失敗terminalを独立fixtureにし、`done`を結果回収済みへ丸めない。
    再stopは成功receiptを返さない実測のため、terminal stateを先に確認し、実行中stop receiptとterminal観測を分離する。

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

- [x] **P3-3 誤配送防止を実装した（[ADR 0020](adr/0020-mailbox-current-parent-routing.md)）。**
  - 成果物: project target、観測host、thread IDによるrouting、旧thread／旧host手紙の失効処理。
  - 完了条件: 別project、旧thread、target不明ではclaimせず、現在project / threadだけが取得できる。
  - [x] projectごとの物理inbox分離と、target / thread完全一致時だけのclaimを実装する。
  - [x] 親Stop payloadからのcurrent target解決、旧thread messageの失効receiptを実装した。
    - Mailbox message／receiptへraw thread IDを保存せず`thread_sha256`へ統一する。
    - Stop payloadのraw thread IDはその場でhash化し、registered target、active watch provider、committed parentの
      host／thread hashが全一致したauthoritative current hookだけをclaim可能にする。
    - authoritative current hookだけが同targetの旧thread messageを本文なし`stale_thread` receiptへ失効させる。
      target不明、watch inactive、旧host／旧thread hookはinboxを変更しない。
    - focused gate: `node --test test/mailbox-store.test.mjs test/mailbox-consumer.test.mjs test/mailbox-routing.test.mjs` — 14/14 PASS。

- [ ] **P3-4 親Stop hook adapterを実装する。**
  - 成果物: Claude／Codex別のMailbox fast path、bounded advisory render、installer / verify / rollback。
  - 完了条件: 両hostでMailboxなしなら短時間で終了し、一件の手紙を同じ親turnへ一度だけ正式なcontinuation promptとして注入できる。
  - [x] **P3-4a Observer所有のparent Stop hook coreを実装した（[ADR 0021](adr/0021-parent-stop-hook-core.md)）。**
    - Claudeは正式な`Stop`の`hookSpecificOutput.additionalContext`、Codexは正式な
      `decision:"block" + reason`だけを使う。
    - raw `session_id`はroute照合中だけ使い、receiptにはprovider／turn相関のdigestだけを残す。
    - `stop_hook_active=true`では新しい手紙をclaimせず、一つの親turnへObserver助言を最大一件にする。
    - claim後のrender、stdout、finalize失敗は本文を再配送せず`delivery_unknown`へ回収する。
    - focused gate: `node --test test/parent-stop-hook.test.mjs test/mailbox-consumer.test.mjs test/mailbox-routing.test.mjs` — 18/18 PASS。
    - `npm run check` PASS。continued turnの実CLI fast pathはexit 0／stdoutなしを確認した。
  - [ ] **P3-4b installer / verify / rollbackを実装する。**
    - Observer側がhook commandと設定fragment生成／検証を所有し、dotagentsは工場配布adapterだけを所有する。
    - 既存hookを上書きせず合成し、Codexでは`async:true`を使わず同期fast pathとして配線する。
    - [x] **P3-4b1 Observer `hook-config`契約を実装した（[ADR 0022](adr/0022-parent-stop-hook-install-boundary.md)／[ADR 0023](adr/0023-parent-stop-hook-config-cli.md)）。**
      - provider別canonical `Stop` entryのJSON生成と、candidate configの
        `missing` / `duplicate` / `noncanonical` / `canonical`判定だけを行う。
      - macOS v1では、実在するabsolute executable pathを明示入力し、空白、制御文字、引用符を含むcommandを拒否する。
      - Host設定を変更せず、fragment／診断のstdout以外へstateを書かない。
      - focused gate: `node --test test/parent-stop-hook-config.test.mjs` — 7/7 PASS。`npm run check` PASS。
      - 実装者ReportはControl revision 28でstrict import、revision 29で親受入した。
    - [x] **P3-4b2 dotagents transactional applierを実装した（[ADR 0024](adr/0024-dotagents-hook-config-adapter-receipt.md)）。**
      - Observerのcanonical fragmentをconsumeし、Claude `settings.json`とCodex `hooks.json`へstandalone Stop entryを各一件に正規化する。
      - dry-runを既定にし、apply時は二設定をbackup／prepare／atomic replaceし、途中失敗は両方rollbackする。
      - 既存hook、matcher group、trust、model、effort、permission、credentialを変更しない。
      - dotagents commit `2fb48cb`、Worker Report strict import revision 45、parent accept revision 46。
      - focused gate `bash tests/install/observer-hook-config.sh`と`make lint-py` PASS。実HOME applyとhost実火は未実施。
  - [ ] **P3-4c live host gateを実証する（H）。**
    - Claude／Codex各一回で、Mailboxなしのfast exitと一件の同一turn continuationを確認する。
    - Host ackが無いv1ではreceiptを`delivered`へ格上げしない。

**Gate:** 手動publishした手紙が正しい親へ最大一回だけ届き、本文が残らない。

---

## Phase 4: Observer AIとノイズ抑制

- [ ] **P4-1 Observer起動契約と出力schemaを実装する。**
  - 成果物: 親と同じproviderを選ぶhost resolver、read-only伴走者役割、禁止事項、`no_advisory` / advisory proposalの固定契約。
  - 完了条件: 異provider Observer、継続的反証、通常会話、実装、自由形式出力へ逸脱した結果をSupervisorが拒否する。
  - [x] 同provider resolverと両host共通runtime prompt、`observer.ai_output.v1`のstrict parser／canonical digestを
    実装した（[ADR 0026](adr/0026-observer-ai-output-contract.md)）。
    - 静的人格はObserver rootの`AGENTS.md`／`CLAUDE.md`、wire protocolは生成promptを正本とする。
    - `no_advisory`への理由追加、複数proposal、未知field、自由文、Markdown、過大出力をfail closedにする。
    - focused gate: `node --test test/observer-ai-contract.test.mjs test/parent-launch.test.mjs test/claude-host-adapter.test.mjs test/codex-host-adapter.test.mjs` — 29/29 PASS。
  - [ ] P4-2の信頼済みcycle contextとP4-3のsemantic gateを通した後、Mailbox publishより前に
    Supervisorが本parserを必須実行し、provider／target／watch／cycleをAI自己申告なしで束縛する。

- [ ] **P4-2 bounded evidence収集を実装する。**
  - 成果物: 新規turn、plan、diff、git、test evidenceの最小snapshot。
  - 完了条件: prompt全文、secret、巨大logを保存せず、手紙のclaimを検証できる参照を作れる。
  - [x] `observer.evidence_snapshot.v1`の32 KiB全体上限、section別上限、redaction／truncation、
    digest-only receiptを固定した（[ADR 0027](adr/0027-bounded-evidence-snapshot.md)）。
    - generation hard ceilingは最大8 completed cycleまたはObserver所有model-visible payload累積256 KiBとし、
      次cycleの開始前にplanned rolloverする。
  - [x] host-neutral snapshot builderとstrict validatorを実装する（[ADR 0031](adr/0031-evidence-snapshot-builder-acceptance.md)）。
    - Throughline turn itemをexact検証し、最新側から最大12 KiBへboundする。
    - plan最大4 refs／6 KiB、git最大8 KiB、test receipt最大16件／4 KiB、全体32 KiBを強制する。
    - raw snapshotを保存せず、digest、bytes、件数、truncation／redaction flagsだけのreceiptを生成する。
    - Control Run 1は契約不足でreject、Run 2はnative無応答をcancelledへ閉じた。未受入成果を成功扱いせず、
      [ADR 0028](adr/0028-evidence-builder-control-wave-boundary.md)によりsuccessor Controlへ移送して継続する。
    - successorの再実装は、別会社Composerの認証H、sidecar config不足、native二失敗を明示した上で、
      execution-verifiedなaiterm Codex一件へ親review配置する（[ADR 0030](adr/0030-evidence-builder-external-executor-placement.md)）。
    - strict Worker Reportを手補正せずimportし、親のfocused 15/15、`npm run check`、対象2 pathの
      `git diff --check`を再確認してControl revision 8でacceptした。実装はcommit `0536d07`へ独立固定した。
  - [x] read-only collectorを実装し、承認済みplan ref、git HEAD／status／diff evidence、既存test receiptを
    snapshot builderへ渡す。collector unavailableを空の成功へ丸めず、利用不能refとして明示する。
    - path containment、1 MiB取得上限、固定git argv、domain-separated source digest、test receipt投影を
      [ADR 0032](adr/0032-read-only-evidence-collector-contract.md)へ固定した。live repoとSupervisor配線は別gateとする。
    - strict Worker Reportを手補正せずimportし、親のfocused 22/22、`npm run check`、対象2 pathの
      `git diff --check`を再確認してControl revision 17でacceptした。実装はcommit `4276615`、受入証拠は
      [ADR 0033](adr/0033-read-only-evidence-collector-acceptance.md)へ独立固定した。
  - [ ] generation stateへcycle数とmodel-visible byte数を耐久化し、8 cycle／256 KiB到達前の
    terminal確認付きplanned rolloverへ接続する。
    - 一parent session epochへ一論理Observer、一watch内で一active generationを維持する。
    - model呼出し前のexact reservation、8 completed cycle、262,144 UTF-8 bytes、fresh generationでも
      一入力が超過する場合のfail-closedを[ADR 0034](adr/0034-generation-budget-and-planned-rollover.md)へ固定した。
    - generation state／budget reservation、cycle transaction接続、host terminal／次generation起動を
      独立gateに分け、旧generationのterminal不明時は新世代を起動しない。
    - [x] generation stateとmodel呼出し前のexact reservationを実装した。strict Worker Reportを手補正せず
      importし、親のfocused 24/24、`npm run check`、対象2 pathの`git diff --check`を一度再確認して
      Control revision 25でacceptした。実装はcommit `9a2b899`、受入証拠は
      [ADR 0035](adr/0035-generation-state-store-acceptance.md)へ独立固定した。
    - [x] cycle cursor commitとgeneration completionを同一target transactionへ接続した。
      - Supervisorをinput構築とmodel処理へ分離し、予約成功後だけmodel callbackを呼ぶ。
      - pending cycle v2へinput digest／bytesを保存し、cursor／generation／cleanupを同じlockで
        crash-recoverableに適用した（[ADR 0036](adr/0036-cycle-generation-exact-once-transaction.md)、
        [ADR 0037](adr/0037-cycle-generation-exact-once-acceptance.md)）。
    - [ ] provider別host terminal確認と次generation activationを接続する。
      - [x] host-neutral journal／watch handle CAS／provider recovery補助をfake fixtureで実装した
        （[ADR 0040](adr/0040-generation-host-rollover-core-acceptance.md)）。
      - [x] Supervisor processから既存provider bindingを同じverified runtimeで回収する非live統合を実装した
        （[ADR 0071](adr/0071-supervisor-planned-rollover-acceptance.md)）。
      - [ ] coreが返すauthorization／receiptを実Claude／Codex commandへ結ぶbindingとH受入を完了する。

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
  - [x] project-ownedな`.codex-sidecar.yml`を追加し、read-only presetと隔離worktree writer、
    Observer製品面だけのpath allowlist、明示model policyを正規dry-runで検証した。
    - `codex-sidecar diagnostics --project .`: `status=ok`。
    - `codex-sidecar review --project . --preset review --dry-run ...`: `status=dry-run`、App Server未呼出。
    - `codex-sidecar factory-diagnostics --project . --preset review`: 0.3.7三package一致、`overall=ready`。

- [ ] **P5-3 最終監査とknowledge returnを完了する。**
  - 成果物: Find → Dedup → 反証 → Critic → 親裁定、RAG / caveat / docsへの還流記録。
  - 完了条件: P0/P1問題が残らず、全受け入れ条件を親が裁定し、本プランをarchiveできる。

---

## v1受け入れ条件

1. projectの絶対パスだけで監視を開始でき、Claude／Codexの親スレッド再作成へ自動追従する。
2. Codexの`task_complete`またはClaudeの実証済み完了証拠だけでhost-bound completed cursorが進み、外部Supervisorの最大一時間Throughline waitを起こす。
3. timeout時はAIやMailboxへ報告せず、外部Supervisorが同じcursorから次のbounded wait stepを開始する。
4. crash、timeout境界、重複通知があっても確定turnを失わず、同じturnを二重監査しない。
5. ObserverはprojectとThroughlineをread-onlyで扱い、実装、停止、Task変更を行えない。
6. Observerは親と同じprovider familyで動き、正常進行では沈黙し、証拠、重要性、行動可能性のある助言だけを送る。継続的な反証役にならない。
7. 別project、旧thread、不正messageを配送せず、正しい手紙を親へ最大一回だけ注入する。
8. 配送後は本文を削除し、boundedなdigest-only receiptだけを残す。
9. Claude／Codexの親Stop hook adapterはMailboxなしで高速に終了し、外部LLM、network、long-pollへ同期依存しない。
10. E2E、fault injection、installer、verify、rollback、full CI、最終監査、knowledge returnが完了する。
11. 利用者の明示指示を受けた親だけが同provider Observerを起動し、一targetで二重起動しない。
12. Claude／Codex ObserverはcanonicalなObserver rootを実行`cwd`とし、監視対象ごとの擬似projectやtemporary repoを作らない。
13. 一つの親session epochには一つの論理Observerだけが伴走し、同時にactiveな物理host generationを一つへ制限する。
    context rollover後もcursorとbounded stateを維持し、raw会話履歴を記憶装置にしない。
