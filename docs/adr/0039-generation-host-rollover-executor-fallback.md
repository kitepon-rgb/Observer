# ADR 0039: generation host rollover実装を検証済みexternal Codexへ引き継ぐ

日付: 2026-07-15

## Status

Accepted。`observer-generation-host-rollover-core-run-1`のterminal failure記録後に限り、同じTaskのrun-2を起動する。

## Context

`observer-generation-host-rollover-core-run-1`は、実装差分を作る前にnative implementerの
`Selected model is at capacity`で終了した。Observer workspaceにrun-1由来の差分はなく、Control Recordでは
revision 40に`failed`とterminal evidenceを保存済みである。

## Decision

1. Task、受入条件、write scope、non-goalは変更しない。
2. run-2はrun-1と同じassignmentの一回だけのretryとし、`fallback.from_worker_run_id`でrun-1へ相関する。
3. 実行者はControl Recordで`execution-verified`のaiterm Codex laneへ切り替える。
4. 共有worktreeへのwriterはこのrun-2だけとし、Taskの非交差write scopeを越えさせない。
5. run-2のpacketとWorker Report skeletonをdispatch前に保存し、親が実diff、focused test、`npm run check`を再確認する。
6. commit、push、branch変更、stash、live provider、credential、H操作は委譲しない。
7. run-2開始前にrun-1のterminal確定とworkspace無差分を確認し、同一Taskの重複実行を許さない。

## Rejected alternatives

- native implementerを即再送する案: capacity failureのterminal記録とretry系譜が曖昧になる。
- 親が実装を引き取る案: Aの仕様固定実装であり、Fへ格上げする契約上の理由がない。
- 未検証の別providerへ切り替える案: writerに必要な`execution-verified`契約を満たさない。
