# ADR 0093: provider cleanup replayをgeneric completed証拠へ束縛する

日付: 2026-07-16

## Status

Accepted for corrective implementation。

## Context

P5-1a core E2Eで、Codex provider journal cleanup後、Mailbox publish後、generic model operationの
`applied`保存前にcrashする窓を再現した。再開時のgeneric operationは`completed`、provider journalは欠損、
semantic decisionとMailbox publish receiptはexact replay可能な状態にある。

`cleanupCodexModelOperation`は欠損journalを無条件成功にせず、generic `completed`と同じoperation ID、
provider receipt digest、completed output digestを要求する。しかしproduction callbackは
`providerCleanupOperation()`に含まれる二digestを`cleanupEvidence`へ渡しておらず、正しい再入も
`E_CODEX_CLEANUP_FORBIDDEN`で永久停止した。

## Decision

1. `runSupervisorProductionStep`のCodex cleanup callbackは、Supervisorがstrict検証済みの
   `operation.provider_operation_receipt_digest`と`operation.completed_output_digest`を、同じcallの
   `cleanupEvidence`へexact投影する。
2. `cleanupCodexModelOperation`のfail-closed条件は緩めない。provider journal欠損を、generic status、
   operation ID、二digestの完全一致なしでcleanedにしない。
3. raw output、thread／turn handle、message本文をcleanup evidenceへ追加しない。
4. Claude productionは引き続き`provider_unavailable`とする。将来Claude callerを接続する時も同じ
   generic completed証拠を使い、別job／logsへfallbackしない。

## Acceptance

- focused unitでproduction callbackが二digestをexactに渡す。
- P5-1a E2EのMailbox publish直後crashが、別requestや二重messageなしで一件へ収束する。
- provider receiptまたはoutput digest不一致の既存拒否を維持する。
