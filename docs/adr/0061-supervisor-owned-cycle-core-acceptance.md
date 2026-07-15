# ADR 0061: Supervisor-owned cycle coreを受け入れる

日付: 2026-07-15

## Status

Accepted。commit `3f35dbb`のcorrective coreだけを受け入れる。production Supervisor caller、Claudeの公開
cycle delivery、hook trust、credential／networkを受け入れたことにはしない。

## Scope

- [ADR 0060](0060-supervisor-owned-cycle-runtime.md)どおり、product contract、Observer AI prompt、Claude tool
  allowlistを外部Supervisor単一所有へ揃えた。
- Codex cycle deliveryを同じpersistent threadへの一cycle一`turn/start`へ変更し、thread／session／cwdと
  cycle turnをprovider journal schema v2へ束縛した。
- generic `dispatching`では保存済みreceiptを再提示し、generic `accepted`ではexact cycle turnをpollする。
  `inProgress`、`completed`、`failed | interrupted`を分離し、completed状態の後退、別turn、複数result、本文変造を
  成功へ丸めない。
- Claude recoveryもgeneric statusを区別し、provider acceptedを永久に再提示してresult pollを飛ばす経路を閉じた。
- `turn/steer`、Codex Stop seal、`after_item_id` baseline、project-local Stop continuationはproduction cycle
  deliveryから除外した。既存MCP serverは削除せずcompatibility／diagnostics裁定を後続Taskへ残した。

## Verification

- focused: `node --test test/cycle-input.test.mjs test/observer-ai-contract.test.mjs test/codex-host-adapter.test.mjs test/codex-model-operation.test.mjs test/claude-host-adapter.test.mjs test/claude-model-operation.test.mjs`
  — 38 PASS / 0 FAIL / 0 SKIP。
- related: `node --test test/supervisor-cycle.test.mjs` — 16 PASS / 0 FAIL / 0 SKIP。
- static: `npm run check`、`git diff --check` — PASS。
- full regressionはPhase gateへ集約するため本TODOでは未実行。
- 実装前の独立反証で、AI wait loopとSupervisorの二重所有、`turn/steer`とStop continuationのidle矛盾、
  child startからcursorを得られない開始不能を確認した。指摘はcorrective契約へ反映済みで、同TODOへの監査は反復しない。

## Remaining gates

- 外部Supervisorからprovider operationを駆動するproduction callerを一target一process／一cycle一stepで接続する。
- Codex live app-serverでrequest ACK、session／turn相関、exact result、hook不要性をversion固定する。
- Claude background／resumeの公開非対話request surface、ACK、session相関、隔離Stop captureをlive H gateで実証する。
  成立しない場合は`provider_unavailable`を維持し、別job spawn等へfallbackしない。
- Observer MCP adapterのcompatibility／diagnostics上の存廃をPhase 2完了前に別Taskで裁定する。
