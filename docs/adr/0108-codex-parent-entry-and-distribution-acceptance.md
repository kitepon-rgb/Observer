# ADR 0108: Codex parent entryとdotagents配布を受け入れる

日付: 2026-07-16

## Status

Accepted。P5-1b2だけを完了とする。Claude公開面characterization、Claude caller、
dual-host live campaignは未完了のまま残す。

## Evidence

- design `659924c`:
  [ADR 0107](0107-codex-parent-entry-and-distribution-contract.md)
- Observer implementation `0690ee0`: `observer parent codex run` foreground entry、
  installed package root、exact Codex parent context、signal／sanitized exit contract
- dotagents implementation `21bc352`: `run-observer-parent-watch` Codex skill、
  official／legacy片面配布、同一session回収手順
- Observer focused gate: CLI 12/12
- Observer related gate: CLI、caller core、product diagnosticsの25/25
- Observer static gate: `npm run check` green
- skill gate: skill-creator `quick_validate.py` green、skill smoke green
- isolated HOME gate: official／legacy install／verify、skill symlink
  rollback／reinstall green
- package gate: pack、install、reinstall、product verify、uninstall／rollback green
- dotagents static gate: `make lint` green

公開entryは`--runtime-root`を受けず、installed Observer package rootからruntime contextを作る。
Throughline／Codexは明示absolute candidateを既存verifierへ渡し、providerをPATH、rate、
環境変数から推測しない。dotagents skillはNodeからCodex native toolを偽装せず、標準execの
foreground sessionを親handleとして保持し、timeout／unknown後も同じhandleだけを回収する。

## Decision

P5-1b2を受け入れる。次の実行順はP5-1b3 Claude public surface characterization Hである。
公開非対話reply ACK、exact result read、job／session／Stop相関をliveで一度確認するまで、
Claude callerを実装しない。

今回のgateはlive provider、model request、credential、login、実HOME config、hook trust、
publish、deploy、pushを実行していない。full regressionと独立重監査はPhase O2完了時に
一回だけ行う。
