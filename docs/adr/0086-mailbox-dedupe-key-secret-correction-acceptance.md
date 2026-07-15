# ADR 0086: Mailbox dedupe key secret補正を受け入れる

日付: 2026-07-16

## Status

Accepted。design commit `414a15b`とcorrective implementation `ae7e336`を受け入れる。

## Accepted behavior

- Mailboxへdurable保存する`dedupe_key`を、title、body、suggested action、evidence refsと
  同じfixed secret pattern検査へ含める。
- secret形式のdedupe keyは`E_MESSAGE_SENSITIVE_CONTENT`で拒否する。
- 正常key、message schema、digest、publish、consume、routing、parent Stop wireは変更しない。

## Verification

- focused red: 修正前の`test/mailbox-store.test.mjs`は6 PASS / 1 FAILで、
  secret形式dedupe keyが受理されることを再現した。
- focused green: 同file 7 PASS / 0 FAIL / 0 SKIP。
- related: Mailbox store／consumer／routing、cycle application、parent Stop hook
  — 30 PASS / 0 FAIL / 0 SKIP。
- static: `npm run check` — PASS。
- full regressionはPhase O2 gateへ集約するため未実行。

## Scope

P4-3 semantic decision、dedupe／cooldown state、retentionは変更していない。次のready TODOへ戻る。
