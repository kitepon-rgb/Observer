# ADR 0089: advisory semantic cycle統合を受け入れる

日付: 2026-07-16

## Status

Accepted for P4-3b。design commit `539b2f2`、runtime core `0c502ec`、
cycle integration commit `c007e06`を受け入れる。semantic behavioral evalと実provider採否は未受入である。

## Accepted behavior

- `applyCycleOutput`はdurable outputとcanonical cycle inputを照合した後、candidate messageを
  operation由来ID／durable作成時刻でsealし、secret、期限、schema、content digestをsemantic state保存前に検証する。
- semantic operationをtarget／watch／generation／cycle／input／output／operation digestへ束縛する。
  acceptedだけを既存`publishOperationMessage`へ渡し、exact publish receipt後に
  `accepted_published`へ進める。
- `evidence_ineligible`またはcooldownによるsuppressed decisionはMailboxを作らず、専用result digestを
  `observer.cycle_result.v1`へ返す。`no_advisory`へ偽装しない。
- publish後・semantic confirm前crashは、同じoperation messageとpublish receiptのexact replayだけで回収する。
- `finalizeCycleApplication`はsemantic preflightをMailbox cleanupより前に行う。件数、retention、active cooldown、
  1 MiB byte capをprospective historyで非変更検証し、飽和時はpublish receiptを残して停止する。
- acceptedはdurable `accepted_published`を正本にMailbox receiptをcleanupしてからsemantic historyへ移す。
  suppressedはMailbox cleanupを呼ばずhistoryへ移す。cleanup後・history finalization前crash、
  history write後・current remove前crashはいずれも同一identityへ収束する。
- semantic lock中にMailbox lockへ入らない。prepare、publish、confirm、preflight、cleanup、finalizeを
  分離し、lock順の循環を作らない。
- finalization preflight／resultはtarget、operation、result digest、decisionを持つexact receiptとし、
  dependency seamの別identity／未知fieldを拒否する。
- Supervisor production callerはapplyとfinalizeへ同じ製品clockを明示し、read-only execution fixtureも
  admissible evidenceを持つ実semantic pathを通す。

## Verification

- characterization red: 旧cycle applicationに対するsemantic core／cycle fixtureは
  16 PASS / 6 FAIL / 0 SKIP。semantic receipt欠損、suppressed未分岐、confirm／preflight未接続を再現した。
- focused completion: semantic decision／cycle application — 24 PASS / 0 FAIL / 0 SKIP
  （関連gateと同一実行内で確認し、別の重複実行はしていない）。
- related: semantic decision、cycle application／input、evidence snapshot、Mailbox store、model operation、
  private state、read-only profile、Supervisor cycle／production caller
  — 89 PASS / 0 FAIL / 0 SKIP。
- static: `npm run check` — PASS。
- 親がADR 0087、実diff、全fault window、関連gateをTODO完了候補で一度確認した。
- full regressionと重い独立監査はPhase O2 gateへ集約するため未実行。

## Remaining P4-3 gate

- P4-3cでmateriality、actionability、semantic timing、親が具体的に対処中かを、文字列heuristicではなく
  strict behavioral evalへ固定する。
- P4-3c完了前にruntime機械gateだけを「意味gate完成」またはP4-3完了として扱わない。
