# ADR 0077: Supervisor parent rebind統合を受け入れる

日付: 2026-07-16

## Status

Accepted。設計commit `4051002`と実装commit `107d2ca`を、非liveのSupervisor統合として受け入れる。
実Claude／Codex thread switch、cross-provider host switch、process crashの実host検証はPhase O2 H gateへ残す。

## Accepted behavior

- Supervisor production stepはprepared cycleのparent stateをevidence収集／model operationより先に検証する。
  current generation epochと違う時はruntime capabilityを確認したうえでparent rebind authorizationをrecord-firstし、
  sanitized `rebind_required`をprocessへ返す。callback欠損、malformed parent、receipt不正はmodel request前にfail loudとなる。
- Supervisor processは開始時と`rebind_required`後にparent rebind journalをplanned rolloverより先に読む。
  両journal同居、journalなしの非active generation、status／provider／generation／parent epoch不一致を拒否する。
- provider bindingの`progressed`は即時継続、`pending`はbounded poll、`activated`はjournal cleanupとactive
  generation／watchを再読する。`unknown`を別host探索、新spawn、自動restartへfallbackしない。
- cross-provider途中のwatch monitorはjournalのfrom/to providerだけを許し、current providerはactivation後の
  active generation／watchからだけ更新する。generic fixtureで`codex -> claude`の更新を固定した。
- prepared cycleとfixed-through parent proposalはrebind中も保持し、activation後に同じprocess leaseでproduction stepへ戻る。
  process restart時もrebind journalをproduction stepより先に回収する。
- Codex runtimeは同じinitialized app-server sessionとcanonical launch requestでsame-provider rebindを進める。
  Claude runtimeが未受入のため、`codex -> claude`はhost-neutral authorization前に固定errorで拒否する。
  generic fixtureのcross-provider成功をlive provider対応済みへ読み替えない。
- 公開production／process resultへauthorization、cursor、raw handle、launch request、provider outputを含めず、
  CLIは内部`rebind_required`をterminal成功として受理しない。

## Verification

- focused: Supervisor production step／process／Codex process、parent rebind provider binding／coreの
  33 PASS / 0 FAIL / 0 SKIP。
- related: Supervisor cycle／CLI、generation store／planned rollover／parent rebind、watch store、parent launch、
  Codex runtime／transportを含む122 PASS / 0 FAIL / 0 SKIP。
- static: `npm run check`、`git diff --check` PASS。
- full regressionはPhase O2 gateまで未実行。live provider、credential、network、publish、deploy、
  意図的障害試験は未実行。

## Remaining

- 実Codex same-provider thread switchとprocess restart境界のH受入。
- Claude公開cycle delivery、Claude same-provider switch、Claude↔Codex host switchのruntime統合とH受入。
- watch／provider fault用の独立transition／receipt。
