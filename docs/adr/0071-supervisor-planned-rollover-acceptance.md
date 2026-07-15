# ADR 0071: Supervisor planned rollover統合を受け入れる

日付: 2026-07-16

## Status

Accepted。設計commit `f9916a2`と実装commit `2bfc09c`を、
[ADR 0070](0070-supervisor-planned-rollover-integration.md)の非live受入条件で確定する。
実Claude／Codex commandを使うlive provider受入は完了扱いにせず、Phase O2のH gateへ残す。

## Accepted behavior

- Supervisor processは内部`rollover_required`を公開terminal結果にせず、同じprocess leaseと
  同じverified provider runtimeで既存generation host provider bindingを一stepずつ進める。
- process開始時と`rollover_required`後にgeneration stateとraw-free rollover statusを再読し、
  非active generationおよびactivation後・journal cleanup前のcrashをproduction stepより先に回収する。
- `progressed`は即時継続、`pending`はbounded poll、`activated`はgeneration／journal再読へ進む。
  `unknown`、schema不正、target／watch／provider不一致、generation／journal不整合はfail loudにする。
- next generation launch requestは既存active watch identityから純粋に再構成し、新watch予約、
  authorization捏造、raw handle／request本文の耐久化を行わない。
- Codex callbackは同じinitialized app-server sessionとcanonical launch requestへ束縛される。
  公開CLIは内部`rollover_required`を受理しない。

## Verification

- focused: Supervisor process、Codex process、generation provider binding、host lifecycle、CLIの
  43 PASS / 0 FAIL / 0 SKIP。
- related: parent launch、generation store／lifecycle／provider binding、watch store、Codex runtime／transport、
  Supervisor cycle／production step／process／CLIの103 PASS / 0 FAIL / 0 SKIP。
- static: `npm run check`、`git diff --check` PASS。
- full regressionはPhase O2 gateまで未実行。live provider、credential、network、publish、deploy、
  意図的障害試験は未実行。

## Remaining

- parent epoch切替を明示`rebind_required` transition／receiptへ記録する。
- watch／provider faultをterminal確認済みのfault transition／receiptへ記録する。
- 実Claude／Codex commandによるgeneration rolloverはPhase O2のH gateで受け入れる。
