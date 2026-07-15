# ADR 0016: bounded Controlをfoundation waveで閉じてCodex host waveへ継続する

日付: 2026-07-15

## Status

Accepted。この文書はControl finalizationのimmutable証拠として使用するため、使用後は追記・修正しない。

## Context

`observer-independent-foundation-20260714`は、ObserverのscaffoldからClaude host runtimeまでを
同じControlで統括した。Controlのbounded budgetは`max_worker_runs=4`であり、4件すべてを受入済みの
実装Runに使用した。Codex app-server host設計を新たにrefuterへ渡すには5件目のRunが必要になる。

worker上限を無視したdispatch、Control外の事後証拠化、既存Runの上書きは採用しない。また、activeな
predecessorを後継へ指定することもControl契約が拒否する。したがってfoundation waveを受け入れて
archiveし、同じ`docs/plan_observer.md`をobjectiveとするbounded successorへ継続する。

revision 57と58で先に記録した次のTaskは作業の取消ではなく、successorへ移送するためcancelする。

- `observer-codex-host-adapter-refutation`
- `observer-codex-host-runtime`

## Foundation wave acceptance matrix

| 項目 | 証拠 | 裁定 |
|---|---|---|
| host-neutral core | target、parent resolver、Throughline cycle、watch／journal／Supervisor、Mailbox coreの各finalized Task | 受入済み |
| Throughline公開境界 | 実CLI black-box、Observer MCP stdio、標準test／実統合test分離 | 受入済み |
| 親起動transaction | handle先行耐久化、stop／fault相関、watch CAS | 受入済み |
| Codex候補調査 | native read-only不成立、app-server per-thread read-onlyとpersistent thread回収 | 部分受入。production採用はsuccessorで継続 |
| Claude host | background/process characterization、adapter core、実binary verification/runtime | 受入済み。残るlive H gateはactive planで継続 |
| focused regression | `node --test test/parent-launch.test.mjs test/claude-host-adapter.test.mjs test/claude-host-runtime.test.mjs` | 23/23 PASS |
| static gate | `npm run check` | PASS |
| H境界 | Observer、Codex model turn、live child、credential、publish、deploy | 未実行のまま維持 |

## Decision

1. `observer-independent-foundation-20260714`のfoundation waveをfinalizeしてarchiveする。
2. 上記2 Taskは本ADRをDecision証拠にcancelし、successorで新しいTask／Run IDとして記録する。
3. successorは`observer-codex-host-runtime-20260715`とし、predecessor、root ID、sequenceをControl契約で
   連結する。worker budgetを新waveへ持ち越したように見せず、新しいbounded budgetとして宣言する。
4. Observer全体の完了、Phase 2完了、Codex production host採用は宣言しない。現在地の正本は引き続き
   `docs/plan_observer.md`である。
5. 可変planをDecision、regression、knowledge-returnのdigest証拠に使わない。本ADRと既存immutable ADRだけを
   Control finalization証拠にする。

## Friction check

manual normalization、reconstructed evidence、alternate recoveryは使用していない。worker budget到達は宣言済み
上限どおりの正常動作であり、製品不具合TODOは追加しない。

## Consequences

- refuterへのdispatch前packet保存とRun回収をsuccessorで通常どおり実施できる。
- foundation Controlの証拠は後続のplan追記でdigest失効しない。
- Controlが分かれてもObserverの製品TODOは分割せず、active plan一冊を正本として維持する。
