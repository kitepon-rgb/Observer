# ADR 0059: Codex cycle request delivery fixture acceptance

- Status: Accepted for fixture integration
- Date: 2026-07-15
- Contract: [ADR 0058](0058-cycle-request-delivery-contract.md)
- Commit: `1bb7b07`

## Decision

host-neutralな`observer.cycle_request.v1` canonical inputと、Codexの
`thread/read baseline -> turn/steer -> exact ACK -> provider accepted journal` primitiveを受け入れる。

- evidence snapshotは送信前に再検証し、canonical JSONのexact UTF-8 bytesとdomain-separated digestを
  `observer.cycle_input.v1` receiptへ固定する。raw requestはdurable stateへ保存しない。
- Codexは保存済みgenerationのthread／turnだけを読み、active turnとsession／cwdを照合して最後の
  `agentMessage.id`をbaselineにする。同じturnへの`turn/steer` ACK後だけrequest固有handleを保存する。
- ACK不明、ACK mismatch、provider journal保存失敗を別requestへ再送しない。
- provider accepted保存後・generic accepted前のcrash recoveryは、Codex／Claudeとも同じreceiptを
  acceptedとして再提示する。journal欠損だけを`provider_operation_missing`へ正規化し、破損やI/O失敗はthrowする。

## Evidence

- focused:
  `node --test test/cycle-input.test.mjs test/codex-host-adapter.test.mjs test/codex-model-operation.test.mjs test/claude-model-operation.test.mjs`
  — 22成功、失敗0、skip 0。
- related Supervisor gate: `node --test test/supervisor-cycle.test.mjs` — 16成功、失敗0、skip 0。
- static gate: `npm run check` — 成功。
- scoped `git diff --check` — 成功。

## Explicit non-completion

本DecisionはCodex／Claude production host接続やPhase O2の完了を意味しない。次をblocking項目として残す。

1. generation runtimeからCodex issue／recover／Stop captureを構成し、production `runSupervisorCycle` callerへ接続する。
2. Codex Stop hook trust、thread `sessionId`／Stop `session_id`、baselineとStop間の実順序をlive H gateで固定する。
3. Claude background sessionへの公開非対話reply ACKを実証し、隔離`--settings` Stop hookと同じjobへ接続する。
4. Claude公開surfaceが成立しなければ`provider_unavailable`で止め、TUI automation、private protocol、
   `claude -p --resume`の推測利用、別job spawnへfallbackしない。
