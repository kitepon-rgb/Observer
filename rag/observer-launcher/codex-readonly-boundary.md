# Codex Observer read-only境界の実測

**出典:** OpenAI Codex Manual（https://learn.chatgpt.com/docs/agent-configuration/subagents.md、https://learn.chatgpt.com/docs/app-server.md）、Codex CLI 0.144.3生成schema、ローカルrouting smoke  
**取得日:** 2026-07-15  
**確度:** 公式仕様=高、現Mac実測=高、app内persistent thread UX=未検証

## 結論

- Codex native subagentは親turnのlive permission overrideを継承する。custom agentの`read-only`宣言だけでは、
  unrestricted親から起動した子をread-onlyにできない。
- 実測では`sorter.toml`のexpected sandboxが`read-only`でも、実効値は`danger-full-access`だった。
  role／model／effort／developer instructionsは正しくroutingされており、sandboxだけが親由来で上書きされた。
- Codex app-server 0.144.3の`thread/start`は`sandbox`、`approvalPolicy`、`developerInstructions`、
  `ephemeral`、`serviceName`を受理する。`turn/start.sandboxPolicy`は後続turnにも持続する。
- したがってpersistent app-server threadを安全host候補にする。ただし、Codexアプリ内表示、長時間wait、
  crash recovery、interrupt／resume、Observer MCPだけのwrite許可は未実測であり、採用済みではない。

## 再現

```text
verify-codex-agent-routing sorter /root/codex_readonly_runtime_probe
WARN: sandbox は role TOML と不一致（expected='read-only', actual='danger-full-access'）
routing-check: OK
```

公開schemaは`codex app-server generate-json-schema --out <temp-dir>`で生成し、
`ClientRequest.json`の`ThreadStartParams`と`TurnStartParams`を確認した。

## 設計への還流

- ADR 0008でunrestricted親からのnative Observerを禁止した。
- Observer `parent-launch` wireはcharacterization完了まで変更しない。
- prompt規律は補助であり、P2-5の拒否testをsandbox強制の代用にしない。
