# ADR 0017: 全hostを単一のObserverプロジェクトで動かす

日付: 2026-07-15

## Status

Accepted。Codex／Claudeのlive child起動とUI表示確認はH gateとして未実施のまま維持する。

## Context

Observerは任意の監視対象を追うが、hostの`cwd`までtarget `project_root`へ変えると、Codex／Claudeの
アプリ上でtargetごとの別projectが増え、Observer固有の`AGENTS.md`／`CLAUDE.md`も適用できない。
characterizationで使った一時git repoはsandbox候補の実測fixtureであり、production identityではない。

一方、現在のClaude adapter／runtimeは既に`request.runtime_root`をjob `cwd`、agent listの相関cwd、
Observer MCP起動cwdへ使う。Codex app-server schemaは`thread/start`と`turn/start`の双方に`cwd`を持ち、
turn overrideは後続turnへ持続し得るため、両方を同じcanonical runtime rootへ束縛する必要がある。

## Decision

1. Observer hostのproject identityはcanonicalなObserverリポジトリrootであり、Claude／Codexの全spawn、
   start、resume、observe、stop相関で同じ`runtime_root`を使う。
2. 監視対象の`project_root`はchild start envelope、target ID、Observer MCP tool引数だけに保持する。
   host `cwd`、temporary repo、target別のアプリprojectへ投影しない。
3. watchごとにpersistent Codex threadまたはClaude background jobを分けても、全watchは単一Observer
   project配下で動く。thread／job nameはwatch相関でありproject identityではない。
4. `AGENTS.md`は両host共通の静的Observer契約、`CLAUDE.md`はClaude固有差分を所有する。runtime roleは
   exactな`observer.child_start.v1`と`mode=observe`がある時だけ有効にし、開発AIの編集権限と分離する。
5. 起動promptはwatch identity、cursor、観測入力など可変情報だけを追加し、静的な人格・責務・禁止事項を
   targetごとに複製しない。
6. Codex app／Claude UIで単一Observer projectとして表示されることと、既に作られた不要projectのcleanupは
   別のlive H gateとする。request `cwd`やthread `source`をUI確認済みへ読み替えず、sessionを黙って削除しない。

## Verification

- Claude adapter／runtimeの既存fixtureはhost `cwd`、agent list `--cwd`、command option `cwd`を
  `runtime_root`へ固定し、別cwdのjobを相関拒否する。
- Codex adapter/runtimeでは`thread/start.cwd`と`turn/start.cwd`を同じ`runtime_root`へexact固定し、
  target `project_root`または任意cwdを拒否するtestを先行させる。
- 標準gateは`npm run check`、TODO focused gateは変更したhost adapter／runtime testだけを一回実行する。
- 本Decision時のfocused gate:
  `node --test test/claude-host-adapter.test.mjs test/claude-host-runtime.test.mjs` — 15/15 PASS。
- static gate: `npm run check` — PASS。

## Consequences

- target数が増えてもアプリのproject一覧をObserver由来の擬似projectで増殖させない。
- Observer固有の振る舞いをrepoの正典としてClaude／Codex双方へ共有できる。
- target pathは監視identityとして残るため、一target一watch、read-only、Mailbox routingの既存契約を失わない。
- live UI未検証と過去session cleanupは未完として明示的に残る。

## Friction check

manual normalization、reconstructed evidence、alternate recoveryは使用していない。Observer child、Codex model
turn、Claude background job、session削除は実行していない。
