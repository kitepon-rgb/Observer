# ADR 0080: Codex rollover terminalはalready-terminal stop経路のexact receiptだけを使う

日付: 2026-07-16

## Status

Accepted corrective decision。planned rollover provider bindingの既存terminal receipt再構成を訂正する。

## Context

`advanceGenerationHostProviderRollover`は`observeCodexGenerationTerminal`が`terminal`を返すと、private stop handleから
generic `observer.host_receipt.v1`を局所再構成してcoreへ渡していた。しかしCodexの`stopped` host receiptは
`observer.codex_turn_terminal.v1`のthread ID、turn ID、terminal status、観測時刻を必須とする。raw-freeなgeneration
terminal observationにはturn IDがなく、正規validatorを通るreceiptを再構成できない。既存fixtureはcoreをfakeにしていたため、
実`confirmGenerationHostTerminal`境界の拒否を検出していなかった。

## Decision

1. Codex terminal観測後は`stopCodexObserver`を同じ保存済みgeneration ID／stop request／launch request／sessionで呼ぶ。
2. `stopCodexObserver`のalready-terminal planはinterruptを発行せず、保存済みthread／turnと実観測からexact terminal receiptを返す。
3. exact terminal receiptが無い場合は`unknown`を返し、generic receipt再構成、別turn探索、interrupt再送、成功補正をしない。
4. focused fixtureはfake coreでなく正規`validateParentHostReceipt`を通し、Codex terminal object欠損を再発時に失敗させる。
5. Claude経路とspawn／ready経路は変更しない。実Codex commandはPhase O2 H gateまで実行しない。

## Acceptance

- terminal observation時の呼出順が`observe -> already-terminal stop -> core confirm`になる。
- coreへ渡るreceiptがCodex terminal exact schemaを満たす。
- receipt欠損はunknown非終端となり、interruptや別handleへfallbackしない。
- provider binding focused testと静的検査を通す。
