# Codex app-server Observer host runtime契約

**出典:** OpenAI公式 Codex App Server、OpenAI公式 Custom instructions with AGENTS.md、Codex CLI 0.144.3生成JSON Schema

**取得日:** 2026-07-15

**確度:** official-primary / local-schema-verified / 部分実測済み

## 一次資料

- [[raw/app-server]] — `https://learn.chatgpt.com/docs/app-server.md`をMarkItDownで取得（93,935 bytes）。
- [[raw/agents-md]] — `https://learn.chatgpt.com/docs/agent-configuration/agents-md.md`をMarkItDownで取得（8,160 bytes）。
- CLI schema — `codex app-server generate-json-schema --out <temp>`をCodex CLI 0.144.3で生成し、
  `ThreadStartParams`、`ThreadResumeParams`、`ThreadReadParams`、`ThreadListParams`、`TurnStartParams`、
  `TurnInterruptParams`、`TurnCompletedNotification`、`ErrorNotification`を確認した。生成物はversion固有の
  一時検証物であり、repoへ大きなJSON bundleを複製しない。

## wireとhandshake

- stdioは一行一JSONの双方向JSONL。JSON-RPC 2.0と同型だがwire上では`jsonrpc` headerを省略する。
- connectionごとに`initialize`を一回送り、response後に`initialized` notificationを送る。他requestを
  handshake前へ送らない。
- Observer client identityは`clientInfo.name/title/version`で固定し、raw responseやaccount stateを
  Observer stateへ保存しない。

## thread契約

- `thread/start`は`cwd`、`developerInstructions`、`approvalPolicy`、`sandbox`、`ephemeral`、`serviceName`、
  `model`等を受理する。Observerは`cwd=canonical runtime_root`、`approvalPolicy=never`、
  `sandbox=read-only`、`ephemeral=false`をexact指定する。
- `serviceName`はmetrics tagでありproject identityやwatch handleではない。watch identityをそこだけへ
  依存させない。
- `thread/resume`は保存済み`threadId`を必須とし、`cwd`、sandbox、instructions等をoverrideできる。
  Adapter再起動時も同じruntime rootとread-onlyを再指定する。
- `thread/read(includeTurns=true)`はthreadをmemoryへloadせず、subscriptionも開始しないread-only回収入口。
- `thread/list`は`cwd`のexact filterを持つ。spawn response不明時の探索候補にはできるが、target cwdや
  preview近似だけで同一watchを決めない。v1はthread IDを受け取った時点で耐久化し、それ以前の不明結果を
  自動再spawnしない。

## turn契約

- `turn/start`は`threadId`と`input`を必須とし、`cwd`と`sandboxPolicy`をoverrideできる。overrideは同threadの
  後続turnのdefaultになり得るため、Observerは各turnで`cwd=runtime_root`と
  `sandboxPolicy={type:readOnly, networkAccess:false}`を再指定する。
- responseの`turn.id`はactive turnのinterrupt／terminal相関に必要である。durable watch handleはthread ID、
  active operation handleはthread ID＋turn IDとして分ける。
- `turn/interrupt`成功responseは空objectであり、停止完了の証拠ではない。続く`turn/completed`の
  `status=interrupted`を同じthread／turn IDで観測して初めてterminalとする。
- `turn/completed`は`completed | interrupted | failed`を区別する。`error` notificationやtransport終了を
  `completed`へ丸めない。

## AGENTS.mdとproject identity

- Codexは作業開始前に、project rootからcurrent working directoryまで`AGENTS.md` instruction chainを作る。
- Observer hostのthread／turn cwdをObserver rootへ固定すれば、Observer repoの`AGENTS.md`がproject固有の
  静的契約になる。target `project_root`へcwdを切り替えるとtarget側のprojectとinstructionsへ変わるため禁止する。
- instruction discoveryはrun/session開始時に行われるため、live load確認は別のH gateで実証する。

## production採用まで残るgate

- CodexアプリUIで単一Observer projectとして見えること。
- 65秒超wait、adapter crash後の同turn回収、interrupt後terminal観測。
- Observer MCPだけのstate／Mailbox writeとproject write拒否。
- app-server process終了、error notification、unknown結果のfault／recovery相関。

上記未検証を、schema存在や`thread/list source=vscode`だけでexecution-verifiedへ繰り上げない。
