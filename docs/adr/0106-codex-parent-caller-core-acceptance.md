# ADR 0106: Codex production parent caller coreを受け入れる

日付: 2026-07-16

## Status

Accepted。P5-1b1だけを完了とする。Codex parent entry／dotagents配布、
Claude公開面characterization、Claude caller、dual-host live campaignは未完了のまま残す。

## Evidence

- design `133cf37`: [ADR 0105](0105-production-parent-caller-gap-and-order.md)
- implementation `286a6db`: current parent確認、watch予約、同一Codex app-server
  transportでのspawn／ready、initial generation作成、Supervisor loop、terminal stop
- focused gate: caller contractの9/9
- related gate: caller、watch、parent launch、generation、Codex host runtime、
  Codex Supervisor runtime、Supervisor process、Throughline process runtime、
  product diagnosticsを含む77/77
- static gate: `npm run check` green

focused fixtureは、Codex親とruntimeの不一致をwatch予約前に拒否し、spawn unknown、
ready unknown、generation conflict、stop terminal unknownを別runtime／別spawn／成功へ
丸めないことを固定した。同じverified Throughline client、app-server session、ready receiptを
initial generationとSupervisorへ渡し、Supervisorへのownership移譲前だけcallerがcleanupする。
移譲後のmanaged closeは同じtransport上でstop request、interrupt receipt、bounded terminal
observation、watch完了、transport closeの順を守る。

## Decision

P5-1b1を受け入れる。次の実行可能stepはP5-1b2 Codex parent entry／dotagents配布である。
isolated HOMEでinstall／verify／rollbackし、live provider、model request、credential、login、
host config変更は実行しない。

full regressionと独立重監査はPhase O2 gateで一度だけ行う。
