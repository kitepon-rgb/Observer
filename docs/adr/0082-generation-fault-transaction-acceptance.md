# ADR 0082: generation fault transactionを受け入れる

日付: 2026-07-16

## Status

Accepted。ADR 0078のdesign commit `e83970c`とimplementation commit `22cf33a`を、host-neutral core、
Claude／Codex fake host binding、Supervisor実state integrationで受け入れる。実host停止と意図的障害は受け入れていない。

## Accepted behavior

- private `generation-fault.json`をgeneration／watch／provider／parent epoch／固定fault code／停止handleへ束縛し、
  journalを先に耐久化してからgenerationを`fault_required`へ進める。
- fault generationは`fault_required -> fault_stopping -> fault_terminal_confirmed -> faulted`を持ち、pending reservation、
  budget、元rollover reasonを成功へ補正せず保持する。
- active等の未停止sourceだけが`issue_once`を得る。既に`stopping | terminal_confirmed`のsourceと二回目以降は
  `observe_only`になり、unknown outcomeでstopを再送しない。
- provider、target、watch、generation、parent epoch、fault code、保存済みhandleとexact terminal receiptを照合した後だけ、
  generation、watch、journalの順で`faulted`へ閉じる。
- terminal receipt耐久化後のcrashは同じreceiptだけで回収し、別handle／別thread探索や自動restartへ進まない。
- Claudeは保存済みjobのterminal観測、Codexは保存済みgeneration turnの観測後にalready-terminal stop経路から得る
  exact host receiptをcoreへ渡す。unknown／receipt欠損は非terminalのまま保持する。
- Supervisorはprovider termination、model result unknown、その他hard failureを固定codeへ写像し、runtime close前にfaultを
  recordする。外部cancelとwatch明示stopはfaultへ変換しない。
- process再開時はprovider runtime生成、planned rollover、parent rebind、production stepより先にfault journalを検知し、
  `E_SUPERVISOR_GENERATION_FAULT_PENDING`で停止する。
- 公開fault status、provider binding result、CLI errorにhost handle、raw receipt、provider error本文を含めない。

## Verification

- focused: fault core／provider binding／Supervisor process — 22 PASS / 0 FAIL / 0 SKIP。
- related: generation、watch、parent launch、Claude／Codex host runtime、planned rollover、parent rebind、Supervisor —
  107 PASS / 0 FAIL / 0 SKIP（implementation commit `22cf33a`）。
- related gate後に検出した既存Codex rollover receipt欠陥は、別corrective commit `fe4f743`と
  [ADR 0081](0081-codex-rollover-terminal-receipt-acceptance.md)のfocused 6/6で閉じた。fault実装fileは変更していないため、
  107件を反復していない。
- static: current HEADで`npm run check`、`git diff --check` PASS。
- full regression、live Claude job／Codex thread停止、intentional provider fault、credential／networkは未実行。

## Remaining H gate

- Phase O2で現在親から実Claude／Codex host actionへbindingし、同一handleのterminal receipt、process crash recovery、
  利用者へのfault報告を個別承認のうえ受け入れる。
- fault後の自動restart、takeover、別handle探索、別provider fallbackは今後も追加しない。
