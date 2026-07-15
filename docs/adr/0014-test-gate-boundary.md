# ADR 0014: 標準testと実Throughline統合testを明示分離する

日付: 2026-07-15

## Status

Accepted

## Context

Observerの標準gateは`npm test && npm run check`だが、`npm test`の`node --test`が
`test/throughline-black-box.integration.mjs`も自動発見する。このtestは実Throughline CLIの絶対pathを
`OBSERVER_THROUGHLINE_BIN`へ要求するため、通常環境では70件PASS後に1件FAILし、標準gateが自己完結していない。

環境変数がない時にtestをskipすると、実統合を検証したかが成功表示から判別できない。

## Decision

- `npm test`は`test/*.test.mjs`だけを実行し、runtime dependency不要の標準gateとして保つ。
- 実Throughline black-boxは`npm run test:throughline-integration`で明示実行する。
- 統合scriptは`OBSERVER_THROUGHLINE_BIN`の絶対path要求を維持し、未指定時はfail loudにする。
- black-box test本体とThroughline CLI契約は変更しない。

## Consequences

- 標準gateは外部repoの配置に依存せずgreenを判定できる。
- 統合testはskip数へ埋もれず、実行有無と失敗がコマンド単位で分かる。
- Phase／release gateでは標準gateに加えて明示統合scriptを実行する必要がある。
