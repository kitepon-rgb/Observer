# ADR 0075: parent rebind provider bindingを受け入れる

日付: 2026-07-16

## Status

Accepted。host-neutral parent rebind transactionをClaude／Codexの公開runtimeへ一command一stepで接続した。
Supervisor process統合、実thread／host switch、crash recoveryのlive H gateは未完であり、本受入には含めない。

## Accepted implementation

- core correction commit `d7ebdbb`は、recoveryのたびにauthorization receiptをexact照合し、
  `spawn_authorized`以降は記録済みlaunch request digestを再照合する。
- provider binding commit `3a737ad`は、rebind専用status/actionからold stop／terminal、new spawn／readyを
  Claude／Codex runtimeへ接続する。planned rollover journal／bindingへfallbackしない。
- cross-provider時はnew providerのlaunch requestをold provider commandへ流用せず、同じtarget／watch／runtime rootから
  old provider用requestをcanonicalに再構成する。
- Codex terminalは`stopCodexObserver`の相関済みparent terminal receiptをそのままcoreへ渡す。
  raw-free generation terminal observationから不完全receiptを合成しない。
- Codex ready recoveryはread-only回収を先に行い、`thread_created`だけが保存済みthreadへの一回の
  `turn/start`を許す。`running`はready receiptを回収し、`turn_start_unknown`は別turnを発行せずunknownを返す。
- 公開binding resultはschema、from/to provider、target／watch、phase、outcome、reasonだけを返し、
  raw thread／job handle、request本文、provider outputを含めない。

## Gate evidence

- focused: `test/generation-parent-rebind-provider-binding.test.mjs` 6/6 green。
- related: parent rebind core、generation/watch store、parent launch、Claude/Codex runtime、既存rollover bindingの
  66件を対象にした。65件green後、既存`claude-host-runtime` fixtureの旧tool allowlist期待だけが失敗したため、
  正本TODOへ登録してcommit `d34b119`で補正し、失敗scope 1/1をgreenにした。同じproduct filesでgreenだった65件は
  再実行せず再利用し、66/66へ収束した。
- static: `npm run check` green。
- diff: provider bindingは新規2ファイルだけをpathspec commitし、`git diff --cached --check` green。

## Remaining work

- Supervisor production processが`rebind_required`をdurable transactionへ変換し、new epoch activation後に
  保存済みprepared cycleへ戻る統合。
- 実Claude／Codex same-provider thread switch、cross-provider host switch、terminal不明、process crash境界の
  Phase O2 H gate。
- watch／provider fault用の独立transition／receipt。
