# ADR 0152: Codex bootstrapをterminal notificationでgateし実行homeを隔離する

日付: 2026-07-26

## Status

Accepted for execution。

## Context

Observer 0.1.3は新watchのgeneration切替を完了したが、Codex 0.144.6の`turn/start` ACK直後に
`thread/read(includeTurns=true)`を発行すると、rollout session metadataのflush前で
`-32603: rollout ... is empty`となる競合を実環境で再現した。

同時に、`--disable hooks --disable plugins`はglobal `config.toml`由来のMCPを無効化しないことも判明した。
production Observer AIのtool allowlistは空であり、利用者のglobal hooks、plugins、skills、MCP、Appsを
子threadへ継承してはならない。

## Decision

1. bootstrapは保存済みthread ID／turn IDの`turn/completed` notificationをexact相関して待つ。
2. notificationが`completed`の時だけ`thread/read`し、durable turn statusとの一致を確認する。
   `failed | interrupted`、timeout、identity不一致を別turnの再送へ丸めない。
3. Codex app-serverはObserver state配下の0700 isolated `CODEX_HOME`で起動する。
4. 元Codex homeから接続するのは、本人ownerかつgroup／other権限なしの`auth.json`への固定symlink一件だけとする。
   secret本文、config、hooks、plugins、skills、MCP定義を複製しない。
5. 不要なCodex featureを起動argvで無効化し、MCP startup notificationが残れば隔離違反としてfail loudにする。
6. 0.1.4を公開・global installし、installed production watchの`active`継続を最終受入条件とする。

## Acceptance

- `turn/start` ACKから`turn/completed`まで`thread/read`を発行しない。
- notificationとdurable threadのthread ID／turn ID／terminal statusが一致する。
- isolated homeにglobal `config.toml`、hooks、plugins、MCP定義がなく、instruction sourceがObserver repoだけである。
- 認証connectorは元0600ファイルへのexact symlinkで、別targetや通常fileを拒否する。
- focused／full／package gateがgreenである。
- installed 0.1.4のbingo watchとforeground callerが`active`を維持する。

## Rollback

- npm公開前は変更commitをrevertする。
- 公開後は0.1.4をunpublishせず、必要ならdeprecatedにして0.1.3へglobal installを戻す。

## Outcome

commit `71e66cf`を`origin/main`へpushし、annotated tag `v0.1.4`を公開した。
full 422/422、static check、isolated package install smokeを通し、
`@quolu/observer@0.1.4`をnpmへ公開した。registry shasumは
`a1c083c653516175aaf3bff974de284752223658`、global diagnostics／MCP diagnosticsは`ready`である。

installed 0.1.4からbingo watch `w_194bceab-d266-492a-943c-aefa8692cdce`をforeground起動し、
bootstrap完了後に`active`を確認した。isolated `CODEX_HOME`はglobal config／MCPを継承せず、
認証元への固定symlinkだけを保持する。foreground callerは終了させず稼働を継続している。
