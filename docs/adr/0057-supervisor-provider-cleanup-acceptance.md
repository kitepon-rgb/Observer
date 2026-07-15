# ADR 0057: Supervisor provider cleanup acceptance

- Status: Accepted
- Date: 2026-07-15
- Implements: [ADR 0055](0055-provider-exact-result-journal-contract.md) handoff rules 17-18
- Commit: `3600876`

## Decision

Supervisorのcompleted operation処理を、次の耐久順序へ固定する。

1. provider completed callbackのreceiptとcanonical outputをgeneric model operationへ保存する。
2. raw outputを含まない`cleanup_only` operation receiptを`cleanupProviderOperation`へ渡す。
3. provider側がgeneric completedのoperation ID、provider receipt、completed output digestを再照合して
   provider journalを削除する。
4. callbackがexactな`{"schema":"observer.model_operation_cleanup.v1","outcome":"cleaned"}`を
   返した後だけcycle applyへ進む。

generic operationが既に`completed`のrecoveryでも2から再開する。provider journal削除後の再実行は、
Supervisorが渡した同じreceipt／output digestとgeneric completedが一致する場合だけ冪等成功にする。
cleanupのthrow、不正schema、不正outcomeは丸めず、apply／processed／generic cleanupへ進めない。
既に`applied`のoperationはprovider cleanup済みという一方向遷移を前提にapplyを再実行しない。

## Evidence

- focused:
  `node --test test/codex-model-operation.test.mjs test/claude-model-operation.test.mjs test/supervisor-cycle.test.mjs`
  — 26成功、失敗0、skip 0。
- related static gate: `npm run check` — 成功。
- scoped `git diff --check` — 成功。
- cleanup callbackへcanonical/raw output本文が含まれないこと、cleanupが失敗した時に
  `applyModelOperation`が呼ばれないことをfocused fixtureで確認した。

## Remaining boundary

provider journal coreとSupervisor handoffは接続済みだが、host adapterからのaccepted handle作成、
Codex Stop seal／baseline item取得、Claude隔離Stop hook注入は未接続である。live H gateを含むhost接続が
greenになるまでprovider exact-result TODO全体とPhase O1を完了扱いにしない。
