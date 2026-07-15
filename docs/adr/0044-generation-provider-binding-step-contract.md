# ADR 0044: generation provider bindingを一command一stepで進める

日付: 2026-07-15

## Status

Accepted for implementation。Codex terminal recoveryとhost-neutral bindingを非交差の2 Taskへ分割する。
live providerはH gateに残す。

## Context

[ADR 0043](0043-generation-recovery-surface-acceptance.md)でhost-neutral recovery contextとCodex generation
runtimeを受け入れた。次はcoreのrecord-first authorizationをClaude／Codex commandへ接続する必要がある。

ただし`stop_authorized`は「stop command送信済み」を意味しない。core journal作成後・command前にcrashした場合、
再開時は同じstopを送らずterminalだけを観測しなければならない。既存`stopCodexObserver`はprovider journalが
`running`ならinterruptを発行できるため、再開時のread-only terminal観測へそのまま使えない。

また、新generationのspawn receiptをcoreへ保存してからready commandを始めると、その間のcrashでcoreは
`spawn_observed`、providerはready未開始となる。readyを推測再送せず回復できないため、provider側でspawnとreadyを
耐久化してからcoreへspawn／readyを連続適用する必要がある。

## Decision

1. 公開bindingは`advanceGenerationHostProviderRollover`一入口とし、一回の呼出しでmutating provider commandを
   最大一件だけ発行する。暗黙loop、sleep、fallback、別watch作成を行わない。
2. rollover journalが無い時だけ`prepareGenerationHostStop`を呼ぶ。初回`issue_once`では旧host stopを一度だけ
   発行する。journal既存の`stop_authorized`ではread-only terminal観測だけを行い、stopを再送しない。
3. Codex runtimeへ`observeCodexGenerationTerminal`を追加する。同じgeneration namespaceのdurable thread／turnを
   `thread/read`で照合し、terminal receiptまたは`pending | unknown`だけを返す。`turn/interrupt`、新thread、
   新turn、親watch遷移を呼ばない。
4. Claudeのstop recoveryはcoreのprivate stop requestから同じjob IDを照合して`agents --json --all`を読む。
   `working | blocked`ならpending、同じjobの`done | stopped | failed`だけをterminalへ変換する。再開時に
   `claude agents stop`を送らない。
5. `terminal_observed`ではcoreがnext generationを先にauthorizeする。初回`issue_once`だけprovider spawnを一度発行し、
   coreへspawn receiptをまだ保存せず終了する。authorization後・provider journal前のcrashはunknownで止める。
6. `spawn_authorized`ではprovider固有stateからspawn／readyを回収する。
   - Codex: ready済みなら同一thread／turnを回収する。`thread_created`だけならgeneration runtimeで`turn/start`を
     record-firstに一度発行する。`turn_prepared | turn_start_unknown`では再送しない。
   - Claude: deterministic name／canonical cwdのlive候補だけをspawnとして回収し、同じjobの
     `working | blocked`だけをreadyとする。terminal履歴を新generationに再利用しない。
7. provider側でspawn receiptとready receiptの両方が揃った後、同じbinding callで
   `recordNextGenerationHostSpawn`、`activateNextGenerationHost`を順に適用する。これによりcoreが
   `spawn_observed`ならprovider readyは既に耐久回収可能である。
8. `spawn_observed | ready_observed`はprovider readyの回収とcore不足分の適用だけを行う。新しいspawn／ready commandを
   発行しない。
9. bindingの公開結果はschema、provider、watch／target、core phase、`progressed | pending | unknown | activated`、
   bounded reasonだけを返す。raw handle、provider receipt、launch request、verification、session、command stdout／stderrを
   返さず、保存もしない。
10. provider mismatch、別generation、別thread／turn、複数Claude live候補、missing provider journalはfail closedまたは
    明示unknownとし、別経路へfallbackしない。

## Parallel implementation wave

- Task A: `src/codex-host-runtime.mjs`と`test/codex-host-runtime.test.mjs`だけを所有し、read-only terminal recoveryを実装する。
- Task B: 新規`src/generation-host-provider-binding.mjs`と`test/generation-host-provider-binding.test.mjs`だけを所有し、
  本ADRのstep machineを実装する。Codex runtimeはnamespace importとdependency injectionでTask Aの固定APIを参照する。
- 両writerは一時的な別worktreeを使う。親が各Report、diff、focused gateを受け入れて本線へ統合し、統合gate後に
  worktreeを削除する。Observer runtimeのcanonical project rootは変更しない。

## Rejected alternatives

- `stop_authorized`再開時にstopを再送する案: authorization後・command前とcommand結果不明を区別できない。
- spawn receiptをcoreへ先に保存してからprovider readyを開始する案: crash後にready未開始を安全に証明できない。
- 一回のbinding呼出しでterminal待機までloopする案: command境界と一時間waitを再結合し、回復点を失う。
- Claude terminal履歴またはCodex cwd singletonへattachする案: 新generation identityを証明できない。

## Verification gate

- Task A focused: Codex runtime testでinterrupt call 0、新thread／turn 0、同一terminalだけreceipt化を証明する。
- Task B focused: fake providerで各core action、crash matrix、一step一mutating command、公開raw値非保持を証明する。
- 統合後: generation lifecycle、Claude runtime、Codex runtime、provider binding、watch storeのfocused gateと`npm run check`。

