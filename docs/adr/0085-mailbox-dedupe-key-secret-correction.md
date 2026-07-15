# ADR 0085: Mailbox dedupe keyをsecret検査へ含める

日付: 2026-07-16

## Status

Accepted for corrective implementation。P4-3 semantic gateの設計中に再現した既存P3-1境界欠陥を、
semantic transactionとは別commitで修正する。

## Context

Mailbox messageは`dedupe_key`を本文とともにdurable保存する。しかし`assertNoSensitiveContent`は
title、body、suggested action、evidence refsだけを連結し、`dedupe_key`を検査していない。
そのためtoken形式の文字列をdedupe keyへ置いたmessageを`sealMessage`が受理できる。

P4-3ではdedupe keyのdomain-separated digestだけをsemantic historyへ保存する予定だが、公開Mailbox
messageにはraw keyが必要である。history側のdigest化をMailbox側のsecret検査漏れの代用にしない。

## Decision

1. `dedupe_key`を既存のfixed secret pattern検査対象へ追加する。
2. pattern、error code、他fieldのschema、message digest、既存の正常keyは変更しない。
3. focused testはOpenAI key形式をdedupe keyへ置き、修正前に受理される赤を確認してから
   `E_MESSAGE_SENSITIVE_CONTENT`拒否へ変える。
4. P4-3 semantic state、cooldown、retentionは本correctiveへ混ぜない。

## Acceptance

- secret形式の`dedupe_key`を`sealMessage`が拒否する。
- 正常なdedupe key、本文secret拒否、digest／publish契約の既存testがgreenである。
- 変更は`src/message-schema.mjs`、`test/mailbox-store.test.mjs`、本ADRとplanの受入記録だけに限定する。
