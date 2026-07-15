# ADR 0107: Codex parent entryとdotagents配布契約を固定する

日付: 2026-07-16

## Status

Accepted for implementation。P5-1b2の非H範囲だけを定義し、live Codex providerは起動しない。

## Context

[ADR 0106](0106-codex-parent-caller-core-acceptance.md)でproduction caller coreは閉じたが、
installed Observerの通常CLIとdotagentsのCodex配布面から到達する公開entryがない。
低位`observer supervisor run`は既存watchを前提とし、current parent確認、watch予約、
initial generation bootstrapを行わない。Observer MCPはread／wait専用かつ
`production_ai_surface=disabled`であり、起動toolを追加すると別の公開契約になる。

## Decision

1. Observerの既存`observer` binaryへ次のforeground entryを追加する。

   ```text
   observer parent codex run <absolute-project-root> \
     --throughline-command <absolute-path> \
     --codex-command <absolute-path> \
     [--state-root <absolute-path>] \
     [--expected-previous-watch-id <watch-id>] \
     [--timeout-seconds <1..3600>] \
     [--poll-interval-ms <100..60000>] \
     [--plan-ref <file:relative-path>]...
   ```

2. entryは自身のinstalled package rootを`import.meta.url`からcanonical runtime候補として作る。
   `--runtime-root`、環境変数、cwd、PATHからObserver runtimeを推測しない。
3. parent contextはentry内部でexact schemaへ固定する。providerは`codex`、intentは
   `start_observer`、runtime rootは前項のpackage root、previous watchは明示引数または`null`とする。
   caller coreによるverified Throughline current parentのCodex照合を省略しない。
4. Throughline／Codex commandは親がread-only discovery後にabsolute pathで明示する。
   Observerは候補のowner、mode、identity、versionを既存verifierで再検証する。providerを
   command名、rate、installed binary、環境変数から推測しない。
5. CLIは`runCodexParentWatchProcess()`を同じprocessでawaitし、sanitized
   `observer.codex_parent_caller_result.v1`をstdout一行へ返す。SIGINT／SIGTERMは同じ
   `AbortSignal`へ渡し、cancelは130、known fault／verification errorは非0とする。
   unknownを別process、別transport、別spawn、成功へ丸めない。
6. dotagentsにはCodex skill `run-observer-parent-watch`だけを追加する。skillは通常の
   Codex exec入口でCLIをforeground起動し、返されたsession handleを同じtaskで保持・回収する。
   shell background、`nohup`、daemon、自動respawn、Nodeからのnative tool偽装を禁止する。
7. dotagentsはObserver source／runtime／stateを複製しない。Observer packageとstate schemaは
   Observerが所有し、skillは公開CLIの選択・引数・回収手順だけを持つ。

## Acceptance

- Observer focused fixtureでCLI parse、exact parent context、installed runtime root、signal、
  sanitized result／error、exit code、previous watch相関を固定する。
- skillはskill-creatorのinitializerで作成し、frontmatter、`agents/openai.yaml`、
  `quick_validate.py`をgreenにする。本文は公開CLIと標準exec／session回収だけを案内する。
- isolated HOMEでObserver packageのinstall／reinstall／verify／uninstallと、dotagentsの
  official／legacy片面skill symlink、verify、rollbackを確認する。
- focused／related gate中はlive provider、model request、credential、login、host config、
  hook trust、publish、deploy、pushを実行しない。
- full regressionと独立重監査はPhase O2完了時に一回だけ行う。
