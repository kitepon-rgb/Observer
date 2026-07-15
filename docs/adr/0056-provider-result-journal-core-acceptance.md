# ADR 0056: provider result journal core acceptance

- Status: Accepted
- Date: 2026-07-15
- Scope: `observer-provider-result-read-20260715` の provider journal core 2 Task
- Contract: [ADR 0055](0055-provider-exact-result-journal-contract.md)

## Decision

Codex と Claude の provider exact-result journal core を、Supervisor やhost adapterへ未接続の
内部primitiveとして受け入れる。

- Codex は `thread/session/turn/cwd/after_item_id` をaccepted時に固定し、matching Stop seal後だけ
  `thread/read(includeTurns=true)` のbaseline以後を読む。phase欠損/null互換を許しつつ、単一候補か
  明示commentary群＋単一finalだけをcompletedへ束縛する。completed recoveryは保存済みitem IDを
  direct再読してcanonical output digestを再照合する。
- Claude は公開`agents --json --all`のbackgroundかつworking/blockedな
  `job/session/cwd/name` exact一致だけをacceptedにし、matching Stopの
  `last_assistant_message`をstrict parseしたcanonical outputだけを一時耐久化する。
  raw hook payload、account、logs、transcriptは保存しない。
- 両providerともgeneric completedのoperation／receipt／output digest照合前にprovider journalを
  cleanupしない。cleanup失敗をapply成功へ丸めない。
- callbackは`observer.model_operation_callback.v1`のaccepted／pending／completed／unknownだけを返す。

## Evidence

- Control revision 16で両Worker Reportを正規importした。
  - Codex result digest: `7a28b05f19eb678e1525183200f05775a52ba53fcb88c062890025da4412947e`
  - Claude result digest: `b0f30ba5094a5a0244de68a06272c3bcbebd22e9e5ef819b8f55738a59896347`
- 親のcombined focused gate:
  `node --test test/codex-model-operation.test.mjs test/claude-model-operation.test.mjs`
  は10件成功、失敗0、skip 0。
- Claude隔離worktreeからmainへ取り込んだ2ファイルはSHA-256完全一致。
- `git diff --check`は対象4ファイルで成功。

## Explicit non-completion

このDecisionはPhase O1やprovider exact-result TODO全体の完了を意味しない。次を未完のblocking項目として残す。

1. Supervisorへ`completeModelOperation -> cleanupProviderOperation -> applyCycle`を接続し、
   generic completed recoveryでも同じcleanupを再実行する。
2. Codex runtime／Stop hookとjournal coreを接続し、baseline itemとStop session/turn相関を固定する。
3. Claudeの隔離`--settings` hook注入とjob `sessionId`／Stop `session_id`相関をlive H gateで実証する。
4. production enableは上記host接続と関連gateがgreenになるまで行わない。

同じTODOへの独立監査は反復しない。ADR 0055の独立反証で生き残った指摘を本Decisionへ反映済みであり、
次の重い監査はPhase O1完了候補時に一度だけ行う。
