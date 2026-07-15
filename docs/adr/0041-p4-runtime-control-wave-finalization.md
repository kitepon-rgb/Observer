# ADR 0041: P4 runtime Control waveを受け入れてprovider bindingへ継続する

日付: 2026-07-15

## Status

Accepted。この文書はControl finalizationのimmutable acceptance matrixであり、使用後は変更しない。

## Acceptance matrix

| 範囲 | Task証拠 | 検証・裁定 |
|---|---|---|
| bounded evidence snapshot | ADR 0031 | strict builderとreceipt、focused gateを受入 |
| read-only evidence collector | ADR 0033 | plan／git／testのbounded collectorと拒否境界を受入 |
| generation state／budget | ADR 0035 | 8 cycle／262,144 bytes、model前reservation、raw handle非保存を受入 |
| cycle／generation exact-once | ADR 0037 | pending v2、cursor／generation commit、crash recoveryを受入 |
| generation host rollover core | ADR 0040 | watch継続journal、terminal、handle CAS、ready activationを受入 |
| executor fallback | ADR 0039、0040 | native capacity failureをterminal記録後、検証済みexternal Codexへ一回だけ切替 |

## Decision

Control `observer-p4-runtime-20260715`の5 Taskを上表どおり受け入れる。各TODOは親が実diff・受入条件・
focused testを一回確認済みであり、このwaveを閉じるために同じ回帰testや独立監査を反復しない。

これはObserver全体、P4-2、provider binding、model operation journal、live provider、P4 Phaseの完了を意味しない。
現在地と未完条件は`docs/plan_observer.md`に残す。

## Knowledge return

- snapshot builder: ADR 0031。
- collector: ADR 0032、0033。
- generation budget: ADR 0034、0035。
- cycle transaction: ADR 0036、0037。
- host rollover: ADR 0038、0040。
- capacity fallback: ADR 0039。

## Consequences

本Controlをfinalizeし、同じobjectiveを持つsequence 3 successorでprovider別binding、model operation journal、
P4-2統合から再開する。P4完了候補になるまでPhase単位の重い監査は起動しない。
