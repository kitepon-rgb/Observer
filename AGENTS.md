# AGENTS.md

このリポジトリでObserverを開発するAI向けのプロジェクト正典。上位のグローバルAGENTS.mdも併せて適用する。矛盾する場合は、このリポジトリ固有の範囲について本ファイルを優先する。

## プロジェクトの役割

Observerは、指定プロジェクトで動く親AIをThroughline経由で継続観測し、必要な時だけ助言またはソフトストップを届ける独立プロダクトである。

製品として動くObserverは監視対象をread-onlyで扱う。一方、このリポジトリを開発するAIは、承認済みplanの範囲でObserver自身のコード、テスト、文書を編集してよい。この二つを混同しない。

## Observerプロジェクトidentity

- Claude／CodexのObserver hostは、監視対象にかかわらずcanonicalなObserverリポジトリrootを`cwd`にする。
- 監視対象の`project_root`はchild start envelope、target ID、Observer MCPの照合データとしてだけ渡す。hostの`cwd`、一時git repo、アプリ上のproject identityへ投影しない。
- 複数targetを監視する時も、targetごとの擬似プロジェクトや作業フォルダを作らない。watchごとにthread／jobは分けても、すべてObserverプロジェクト配下で動かす。
- Observer rootにある本ファイルと`CLAUDE.md`が静的な製品役割を所有し、起動ごとのpromptはwatch identity、cursor、観測入力など可変情報だけを加える。
- Codexアプリ／Claude UI上の表示確認はlive hostのH gateで別途実証する。`cwd`固定だけをUI表示済みの証拠にしない。

## 製品として起動されたObserverの振る舞い

この節は、検証済みの`observer.child_start.v1`かつ`mode=observe`を受け取った実行時だけ適用する。それ以外は、このリポジトリを開発するAIとしてactive planに従う。

- 親と同じprovider familyの伴走者として振る舞い、第二の親、Worker、常時refuter、実装担当へ変質しない。
- 一つの親session epochには一つの論理Observerだけが伴走する。同じ論理Observerの物理thread／jobは
  context budgetで世代交代してよいが、同時にactiveな世代を複数持たず、会話履歴をdurable memoryにしない。
- 親の確定turnと監視対象をread-onlyで観測する。実装、Task変更、親や他agentの停止、監視対象への書込を行わない。
- 正常進行では沈黙する。証拠、重要性、新規性、行動可能性、タイミングを満たす時だけ、一観測サイクル最大一件の助言候補を作る。
- target、watch、provider、cursorの相関を推測で補わない。欠損、不一致、timeout、回収不能は成功へ丸めず、構造化された失敗としてSupervisorへ返す。
- 許可されたObserver MCPとhostのread-only surfaceだけを使う。shell、外部network、未許可tool、credential、暗黙fallbackを使わない。

## 文書の正本

- 製品の恒久仕様: [docs/00_product-contract.md](docs/00_product-contract.md)
- 現在の実装計画とTODO: [docs/plan_observer.md](docs/plan_observer.md)
- 役目を終えた提案・ドラフト: [docs/archive/](docs/archive/)

実装前に製品契約とactive planを読む。恒久仕様をplanへ複製せず、仕様変更は製品契約、作業の現在地はplanへ反映する。

## 所有境界

Observer repoが所有するもの:

- Observer runtimeと監視loop
- Throughline公開CLIをAI向けtoolへ変換するread-only MCP adapter
- project target、cursor、dedupe、cooldown等のObserver state
- 中央Mailbox、message schema、receipt、cleanup
- 親Claude／Codex向けの薄いMailbox hook adapter
- Observer固有のinstaller、verify、test、runbook

Throughline repoが所有するもの:

- session、turn、handoff、DB schema
- Claude／Codexそれぞれのhostで実証されたturnの確定証拠
- project pathだけから最新の完了済み親threadを解決するread契約
- opaque cursor、完了turn差分read、`wait_for_turn_change`を含む変更通知契約

Throughline変更が必要な場合は、Throughline repoの`docs/`へ独立したplan/TODOを置き、同repoのbaseline、test、commit、rollbackを完結させる。Observer planへThroughline内部実装の詳細TODOを複製しない。

Observer stateをThroughline、Claude、Codex、Throughline以外の他製品の管理ディレクトリへ置かない。連携は公開されたread / wait / hook契約を使う。

## 開発規約

- 現在のactive planにない作業を、見つけたという理由だけで完了条件へ追加しない。
- 実装前にbaselineをgreenにする。baseline自体が未整備なら、active planの最初の成果物として整備する。
- 公開契約、配送transaction、target照合、read-only境界、hook注入はFとして親が裁定する。
- 仕様固定済みのschema、CLI、test、installer、fixture等はAとして委譲できる。
- ライブhook設定、常駐設定、credential、本番publish / deploy、意図的な実環境障害試験はHとする。
- ThroughlineのDB、WAL、mtimeをObserverから直接読む実装へfallbackしない。
- Throughline wait／read、evidence収集、model request／result、Mailbox apply、cursor commitは外部Supervisorだけが所有する。production Observer AI自身へObserver MCPを公開せず、一cycle一件のcanonical inputだけを評価させる。
- project-local Stop hookはmatching provider resultのcaptureだけを行い、待機、次cycleの開始、block continuationを行わない。親への配送は中央Mailboxを読むhost別の親Stop hook adapterとして分離する。
- timeout後の次waitは外部Supervisorが同じcursorから開始する。CLI / schema / state failureではwatchをfaultedにし、provider requestの再送、自動restart、Stop hookによる自己再開を行わない。
- Observerのmodel providerは監視対象の親hostと一致させる。Codex親にはCodex、Claude親にはClaudeを使い、一般Workerのrate-aware配置や異社相談役の規則を適用しない。
- Observerを継続的な反証役として実装しない。既定は沈黙であり、伴走者として価値のある時だけ一観測サイクル最大一件を提案する。
- promptだけでread-onlyを保証しない。実行権限と拒否testで強制する。
- エラーを握りつぶして監視継続を成功扱いしない。timeout、通知不明、配送不明を区別して記録する。
- working treeがdirtyなら既存変更の所有者と意図を確認し、無関係な変更をrevert、stage、commitしない。

## テストと監査

標準検証コマンド:

```bash
npm test
npm run check
```

`npm test`はNode標準test runner、`npm run check`は全`.mjs`の構文検査と`git diff --check`を実行する。runtime dependencyは追加しない。

最低限の検証層:

1. schema、cursor、dedupe、target解決のunit test
2. Throughline公開入口を使うcompleted-only cursor / read / waitのblack-box contract test
3. Observer wait loopとMailboxのintegration test
4. race、crash、timeout、claim失敗のfault injection
5. 親Stopからadvisory continuationまでのE2E
6. installer、verify、rollback、full CI

TODO完了候補ごとに親がdiff、完了条件、関連test、未検証範囲を一回確認する。重い独立監査はPhase完了時に一回だけ行い、細かなpatchごとに増殖させない。

## 文書管理

- `docs/`直下には恒久正典とactive planだけを置く。
- planはチェックボックス、成果物、完了条件、Phase gateを持つ。
- 恒久的な製品挙動、非目標、廃案は製品契約へ置く。
- 完了したplanと役目を終えた提案は`docs/archive/YYYY-MM_<name>.md`へ移す。
- 調査で得た再利用可能な仕様・罠は、対象製品が所有するRAG、caveat、docsへ還流する。

## 報告

各作業で、実施／スキップと理由、変更ファイル、検証結果、未検証範囲を報告する。未実装、未テスト、未確認を成功扱いしない。
