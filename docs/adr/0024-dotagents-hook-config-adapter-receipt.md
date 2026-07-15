# ADR 0024: dotagents hook-config transaction adapter受入receipt

## Status

Accepted。

## Receipt

- repo: `/Users/kite/Developer/dotagents`
- Control: `observer-factory-20260715`
- implementation Task: `dotagents-observer-hook-config-adapter`
- acceptance Task: `dotagents-observer-hook-config-adapter-acceptance`
- implementation commit: `2fb48cbf75c14d8825aff81a6317e6496e5cc566`
- accepted contract commit: `633b0d34f3bc7f1e1df771c0c2292cdb34b33088`
- immutable evidence: `docs/adr/0008-observer-hook-config-transaction-adapter.md`
- evidence SHA-256: `775701537c37d087c42dd0810cd1e25cf9f3307beeea1d91b95ffb8c2a8e54ca`
- Worker Report strict import: Control revision 45
- parent acceptance: Control revision 46
- Task finalization: Control revision 48／49
- focused gate: `bash tests/install/observer-hook-config.sh` PASS
- Python syntax gate: `make lint-py` PASS
- accepted_at: `2026-07-15T06:46:09.668Z`

## Parent decision

dotagentsのtransactional applierをObserver P3-4b2の受入済みdownstream artifactとして採用する。
adapterはObserverのcanonical fragmentとread-only verifierをconsumeし、既存hookを保持したまま
Claude `settings.json`とCodex `hooks.json`を二file transactionとして扱う。

このreceiptはisolated HOME fixtureと静的受入だけを示す。実HOME apply、hook trust、Claude／Codex実火、
delivery ackは未実施であり、P3-4b親項目、P3-4c、P3-4全体を成功へ含めない。
