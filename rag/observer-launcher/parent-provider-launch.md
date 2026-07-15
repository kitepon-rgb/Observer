# Observer親provider launcher調査

**取得日:** 2026-07-15  
**確度:** Codex公式manual=高、Claude公式資料=高、Claude Code 2.1.209現Mac読取実測=高  
**出典:** Codex Manual `Subagents`、dotagents `rag/orchestration/provider-quota-and-claude-runtime.md`と同raw一次資料、`claude --help`／`claude agents --help`／`claude agents --json`

## 結論

- Codexで同じアプリに表示されるObserverは、現在親がcustom agent `observer`をnative subagentとして起動する。
  local Codexはcustom agentを`~/.codex/agents/`またはproject `.codex/agents/`から読み、親がspawn／follow-up／stopを
  orchestrationする。ObserverのNode subprocessから同じnative childを起動する公開shell入口は採用しない。
- Claude Codeは`claude --agent observer --bg --name <name> <prompt>`でbackground sessionを起動できる。
  `claude agents --json --cwd <path>`はjob ID、session ID、cwd、name、stateを返し、`claude logs <id>`と
  `claude stop <id>`が正式な管理入口である。2.1.209でMax account認証済みと既存done sessionのJSON projectionを確認した。
- Claudeの`--bg`と`--print`は併用しない。Observerはbackground job handle、一般headless Workerはstream-json
  sessionという別契約である。
- 両hostとも、Observer stateの`starting`予約を先に行い、host handleを相関してから`active`へ進める。
  host操作は親が所有し、Observer coreはexact request／receiptとstate transactionを所有する。

## 実装へ渡す罠

- user requestの意味はOS processから証明できない。exact authorizationを必須にして暗黙経路を拒否しつつ、
  最終責任は現在親のworkflowへ置く。
- Codex native handleとClaude job IDを同じ文字列kindへ丸めない。
- Claude backgroundはwrite時にworktree／commit／pushへ進み得るため、roleとtool profileのread-only強制ができるまで
  live Observerを起動しない。
- `starting`後のhost失敗を放置しない。固定faultへ閉じ、自動respawnを禁止する。
- stop commandのexitだけで別handleのwatchを閉じない。stored private handleとのreceipt相関後だけ`stopped`にする。
