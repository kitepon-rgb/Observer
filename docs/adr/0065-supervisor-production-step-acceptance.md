# ADR 0065: Supervisor production step coreを受け入れる

日付: 2026-07-15

## Status

Accepted。commit `0ca7abe`のproduction step coreとfake public-surface fixtureだけを受け入れる。
CLI process lifecycle、実Codex app-server、Claude deliveryを完了扱いにしない。

## Accepted behavior

- target固有lockをwaitからcursor commitまで保持し、並走を拒否する。lockはinspectとexpected nonce付き明示recoverだけを許す。
- active watch／private host binding／active generationを再読し、target／watch／provider／Codex threadを照合する。
- prepared cycleのbase／proposed cursorをdigest化し、Throughline turns、approved plan refs、test receiptsからcanonical
  cycle inputを構築する。proposed parent epochがgenerationと違えば旧provider requestへ進めない。
- Codexのissue／recover／cleanupを一cycle固有provider journalへroutingし、cycle application／finalizationから
  Mailbox apply、generic applied、processed、cursor commitへ接続できるcallback束をproduction codeにした。
- ClaudeまたはCodex runtime欠損はwait／pending／model journalより前に`provider_unavailable`を返す。
- production returnをschema／status／provider／cycle IDだけへ縮約し、turn本文、cursor、model output、message本文を返さない。

## Verification

- focused: `node --test test/supervisor-production-step.test.mjs` — 4 PASS / 0 FAIL / 0 SKIP。
- related: `node --test test/supervisor-production-step.test.mjs test/supervisor-cycle.test.mjs test/evidence-collector.test.mjs test/codex-model-operation.test.mjs test/cycle-application.test.mjs test/generation-store.test.mjs`
  — 44 PASS / 0 FAIL / 0 SKIP。
- static: `npm run check`、`git diff --check` — PASS。
- full regressionとlive host requestはPhase O2 gateまで未実行。

## Remaining

- verified Throughline CLIとpre-initialized Codex app-server sessionを所有する外部process／CLI lifecycleへ一step coreを配線する。
- timeout後に同じprocessが次stepへ戻るcancel／fault／explicit stop loopを固定する。
- Codex live requestとClaude公開deliveryをH gateで実証する。
