# ADR 0134: Throughline completed_atをevidence境界でcanonical timestampへ変換する

日付: 2026-07-16

## Status

Accepted。修理済みcandidateを次のObserver provider launchへ使う。

## Context

queue 19eの実Throughline `observer_read.v1`はcompleted turnを公開したが、`completed_at`はepoch
millisecondsの整数だった。これはThroughlineの既存公開契約とtestに一致する。一方、Observer
`evidence_snapshot.v1`は`.sssZ`付きcanonical ISO timestampを要求する。evidence collectorが外部wireを
内部schemaへ変換せず素通ししたため、provider launch前に`E_EVIDENCE_SNAPSHOT_INVALID`となった。

## Decision

1. Throughline wireとObserver evidence schemaはどちらも変更しない。
2. Observer evidence collectorで、各turnの非負safe integer `completed_at`だけを`Date#toISOString()`へ変換する。
3. 変換結果が4桁年のcanonical `.sssZ`でなければfail closedにする。文字列を暗黙受理しない。
4. body、digest、host、thread、順序は変更せず、既存evidence validationへ渡す。
5. 失敗attemptはlive成功へ含めず、独立gate／commit／candidate再pack後に再開する。

## Acceptance

- focused testで実wire整数の変換、文字列、負数、範囲外値の拒否を固定する。
- evidence／Throughline client／Supervisor production stepのrelated gateを一度通す。
- focused 9/9、related 42/42、`npm run check`、対象docs lint、package verifyが成功した。
- 実feedのinstalled smokeは`feed_turns=1 snapshot_turns=1 canonical=true`となった。
- raw session ID、prompt、turn本文、host設定本文はDecision証拠へ保存しない。
