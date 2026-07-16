# ADR 0133: installed packageのObserver runtime rootをcanonical directoryへ固定する

日付: 2026-07-16

## Status

Accepted。修理済みcandidateを次のObserver provider launchへ使う。

## Context

queue 19eで修理済みThroughline candidateからClaude completed receiptを1件確定した後、実packageの
`observer parent claude run`はprovider launch前に`E_THROUGHLINE_RUNTIME_ROOT_INVALID`で停止した。
`observer-cli.mjs`だけがdirectory URLを`fileURLToPath`へ渡して末尾`/`付きrootを作り、`realpath`が返す
末尾なしcanonical pathと不一致になった。preflightは`dirname`で末尾なしrootを作るためgreenだった。

## Decision

1. CLIのpackage rootはmodule file pathへ`dirname`を二回適用し、末尾separatorのないcanonical directoryにする。
2. Claude／Codex parent dispatcherは同じrootを`runtimeRoot`とparent contextへ渡す。
3. testはrootが絶対pathだけでなく`realpath`完全一致かつ末尾separatorなしであることを固定する。
4. provider launch前の失敗attemptはlive成功へ含めず、独立gate／commit／candidate再pack後に再開する。

## Acceptance

- CLI focused testでClaude／Codex両dispatchのcanonical rootを固定する。
- isolated package gateで実tarballのdiagnosticsと公開bin境界を再確認する。
- focused 15/15、related 35/35、`npm run check`、対象docs lintが成功した。
- installed module smokeは`providers=2 root_count=1 canonical=true`、package verifyも成功した。
- raw session ID、prompt、host設定本文はDecision証拠へ保存しない。
