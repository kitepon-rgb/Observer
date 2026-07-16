# ADR 0141: Codex app-server process group cleanupを受け入れる

日付: 2026-07-16

## Status

Accepted。P5-1b5b-r15のsource／test修理を受け入れる。P5-1b5とPhase O2全体は、独立した
post-spawn／pre-ready recovery修理とPhase closure gateが未完了のため閉じない。

## Context

ADR 0140は、detached Codex app-serverのleader terminalだけをlocal process残留0へ読み替えた誤りを訂正し、
固有process group全体の終了を新しい受入条件にした。実装前のfocused characterizationは4/13 pass、9 failで、
負のPGID配送、leader closeとgroup消滅のAND条件、group操作異常、実OS子孫回収の欠落を再現した。

## Decision

commit `c936cfdb7c3c81b782e660fe216a29275013ea1a`をP5-1b5b-r15のsource／test修理として受け入れる。

1. detached childの正のPIDを固有process group IDとして必須化し、全配送とprobeは負のPGIDへ限定した。
2. transport abortと通常closeはgroup全体へSIGTERMを一度送り、grace超過時は同じgroupへSIGKILLを送る。
3. terminal receiptはleader `close`とprocess group不在の両方が成立した時だけ返す。片方だけの場合は成功にしない。
4. group ID欠損、SIGTERM／SIGKILL配送異常、probe異常、bounded上限超過は
   `E_CODEX_PROCESS_TERMINATION_UNKNOWN`でfail loudにし、leader-only cleanupへfallbackしない。
5. Codex JSONL protocol、thread／turn、Observer cycle、Supervisorの非AI責務は変更しない。

## Acceptance evidence

- focused: `node --test test/codex-process-transport.test.mjs` —
  16/16 pass、fail 0、skip 0。
- related:
  `node --test test/codex-parent-caller.test.mjs test/supervisor-codex-process.test.mjs` —
  13/13 pass、fail 0、skip 0。
- static: `npm run check` — syntaxと`git diff --check`がgreen。
- 実OS subprocess fixtureは、leader終了後もSIGTERMを無視する子processを同じ固有groupへ残し、
  grace超過後のgroup SIGKILLで回収した。terminal receipt後は負のPGID probeと子PID probeがともに`ESRCH`、
  fixture process残留は0だった。
- model request、network、credential、intentional live faultは使っていない。

## Correction boundary

ADR 0139のcompleted cycle、65秒超継続、pending stateなし、caller cancel、provider terminal、設定rollback証拠は
維持する。ADR 0139のCodex local process残留0だけは引き続き失効し、本ADRの修理gateで置換する。
過去ADR 0139／0140は追記更新しない。

## Rollback

commit `c936cfd`をrevertし、本ADRの受入れを失効させ、P5-1b5b-r15を未完了へ戻す。leader terminalを
process group消滅へ読み替えず、再修理までCodex production routeのlocal process残留0を主張しない。
