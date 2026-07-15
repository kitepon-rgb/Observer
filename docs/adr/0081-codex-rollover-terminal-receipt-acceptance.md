# ADR 0081: Codex rollover terminal exact receipt補正を受け入れる

日付: 2026-07-16

## Status

Accepted。ADR 0080のcorrective implementation commit `fe4f743`をfocused gateで受け入れる。

## Reproduction

- 既存provider bindingへ正規`validateParentHostReceipt`を接続すると、terminal観測後に局所再構成したCodex
  `stopped` receiptはterminal object不足により`E_PARENT_HOST_RECEIPT`で失敗した。
- 補正前focused: 4 PASS / 1 FAIL / 0 SKIP。fake coreだけでは検出できなかった実core境界の欠陥として固定した。

## Accepted behavior

- Codex terminal観測後は同じgeneration ID、stop request、launch request、sessionを`stopCodexObserver`へ渡す。
- already-terminal planから得たthread／turn／status／observed-at付きexact receiptだけをcoreへ渡す。
- exact receipt欠損は`unknown / terminal_receipt_unavailable`を返し、generic receipt再構成や成功補正をしない。
- pending terminal観測ではstopを再送せず、Claude／spawn／ready経路は変更しない。

## Verification

- focused: `node --test test/generation-host-provider-binding.test.mjs` — 6 PASS / 0 FAIL / 0 SKIP。
- static: `npm run check`、`git diff --check` PASS。
- full regressionと実Codex commandは未実行。Phase完了gate／Phase O2 H gateへ残す。
