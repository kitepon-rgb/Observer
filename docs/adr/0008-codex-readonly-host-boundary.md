# ADR 0008: unrestricted親からのCodex native Observerを禁止する

日付: 2026-07-15

## Status

ADR 0006のDecision 3と「Codexはnative subagent」というConsequencesを本ADRで訂正する。
利用者の明示指示、現在親による起動、同provider、一target一watch、ADR 0007のhandle耐久化は維持する。

## Context

Codexのcustom agentは` sandbox_mode = "read-only" `を宣言できる。しかし公式manualは、親turnの
live runtime overrideをspawn時に子へ再適用し、custom agentのdefaultより優先すると明記している。

Codex CLI 0.144.3の実測でも、`sorter.toml`が`read-only`の親子routing smokeをunrestricted親から
起動すると、`verify-codex-agent-routing`はexpected `read-only`、actual `danger-full-access`を報告した。
role、model、effort、developer instructionsのroutingが正しくても、実効sandboxはread-onlyではなかった。
Observerの禁止事項をpromptだけで守らせることは、P2-5の強制境界にならない。

一方、同versionの公開app-server schemaでは、`thread/start`に`sandbox`、`approvalPolicy`、
`developerInstructions`、`ephemeral`、`serviceName`を指定でき、`turn/start`にも後続turnへ持続する
`sandboxPolicy`がある。persistent Codex threadをper-thread read-onlyで開始できる可能性はあるが、
Codexアプリ内表示、長時間turn、process crash後の回収、interrupt／resumeはまだ実測していない。

## Decision

1. 実効sandboxが`read-only`でない親から、Codex native subagentをObserverとして起動しない。
   custom role TOML、developer instructions、自己申告だけを強制証拠にしない。
2. Codex Observerのhost候補を、現在親が明示指示に応じて起動するpersistent app-server threadへ変更する。
   `thread/start`と各`turn/start`の双方でread-onlyを指定し、approval escalationを成功経路にしない。
3. app-server threadを採用する前に、次を実hostでcharacterizationする。
   - persistent threadが同じCodexアプリのthread一覧から閲覧できる
   - project writeがsandboxで拒否され、readとObserver所有MCPだけが成功する
   - 65秒超wait、同thread継続、parent／adapter crash後の回収、明示interrupt／停止
   - thread ID、turn ID、adapter processの耐久handleとADR 0007 transactionの相関
4. 上記gateがgreenになるまで、`parent-launch`のCodex wireをnativeからapp-serverへ変更せず、
   Codex live Observerをexecution-verifiedと主張しない。候補が不成立ならownerへ再裁定を求める。
5. Claude background hostは本ADRで変更しない。ただしtool allowlistと拒否testがgreenになるまで
   Claude live Observerも起動しない。

## Consequences

- 現在のunrestricted Codex親からObserverを安全にnative spawnできない事実を、UXのために隠さない。
- 「親が起動する」はnative child限定ではなく、現在親が明示authorizationとhost actionを所有する意味になる。
- app-server採用時はCodex handle schema、stop／fault回収、Dotagents role配布を独立したF変更で更新する。
- P2-5がP2-4のlive host adapterより先行gateになる。
