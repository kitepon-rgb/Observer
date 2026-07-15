# ADR 0088: advisory semantic decision coreを受け入れる

日付: 2026-07-16

## Status

Accepted for P4-3a。design commit `539b2f2`とimplementation commit `0c502ec`を受け入れる。
cycle application統合とsemantic behavioral evalを受け入れたことにはしない。

## Accepted behavior

- proposal evidence refの重複とsnapshot全sectionのref曖昧性をfail loudにする。
- snapshotをoperationのtarget／watch／cycleとcycle input digestへexact束縛する。
- missing、unavailable、truncated、redacted evidenceは`evidence_ineligible`としてdurableに抑止し、
  acceptedへ丸めない。
- target単位のprivate current／history／nonce lockで、acceptedを
  `accepted_pending_publish -> accepted_published`へ進め、suppressedを別statusで保持する。
- same operationはidentity、proposal、evidence、accepted result digestの完全一致だけをreplayする。
- same dedupe keyは直近acceptedから60分間、same／lower severityを抑止し、severity escalationを通す。
  60分経過後はsame evidenceも再評価できる。
- historyは30日／最大1000件／1 MiBへboundし、active cooldownをretention／件数cleanupから保護する。
  保護entryだけで飽和した場合は`E_ADVISORY_HISTORY_SATURATED`で停止する。
- history write後・current remove前crashは同じdecision digestだけを`recovered`へ収束させる。
  finalization preflightはhistoryを書き換えず、crash replayとcapacityをexact照合する。
- proposal本文、raw evidence ref、raw dedupe keyはcurrent／historyへ保存しない。

## Verification

- focused: `node --test test/advisory-semantic-decision.test.mjs`
  — 15 PASS / 0 FAIL / 0 SKIP。
- related: semantic decision、cycle input、evidence snapshot、Observer AI contract、private state
  — 41 PASS / 0 FAIL / 0 SKIP。
- static: `npm run check` — PASS。
- 親がADR 0087の受入条件、実diff、focused／related結果をTODO完了候補で一度確認した。
- full regressionと重い独立監査はPhase O2 gateへ集約するため未実行。

## Remaining P4-3 gates

- P4-3bでcandidate messageのseal、semantic current、Mailbox publish receipt、cycle result、
  cleanup、semantic historyを既存model operation順序へ接続する。
- P4-3cでmateriality、actionability、semantic timing、親が対処中かのbehavioral evalを固定する。
- runtime deterministic gateだけを「意味gate完成」またはP4-3完了として扱わない。
