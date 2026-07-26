# ADR 0148: Supervisor failureをruntime close前にfault terminalへ閉じる

日付: 2026-07-26

## Status

Accepted。P5-4 production watchで露出したgeneration fault回収欠陥の補正契約とする。

## Context

Supervisorはhard failureをrecord-firstしてgenerationを`fault_required`へ進めていたが、その後はprovider runtimeを
直ちにcloseしていた。Codex parentのmanaged closeはwatchを通常`stopped`へ閉じる一方、
generation fault provider bindingを呼ばないため、generationとjournalだけが非terminalで残り、
次回起動が`E_GENERATION_ALREADY_EXISTS`で停止した。

## Decision

1. Claude／Codex Supervisor runtimeは`advanceGenerationFault`を所有し、既存の
   `advanceGenerationFaultProviderBinding`へ同じlaunch request、session／verificationを渡す。
2. Supervisorはhard failureをrecord-firstした後、runtime closeより先にfault bindingを進める。
   `progressed`は直ちに再観測し、`pending`はbounded poll後に再観測する。
3. exact terminal receiptでgeneration、watch、journalが`faulted`になった後も、呼出元へ返す元のhard failureは維持する。
4. `unknown`、不正schema、bounded attempts超過、provider transport終了は成功へ丸めず、
   元errorと回収errorを`AggregateError`で保持する。
5. provider runtimeを取得できる前の失敗は、回収不能なfault journalを新規作成しない。
6. 外部cancelと利用者の明示stopは従来どおりfaultへ変換しない。

## Acceptance

- `record -> fault binding -> runtime close`の順序をfocused testで固定する。
- `progressed -> pending -> faulted`を同じruntimeで回収し、pending pollをboundedにする。
- 実state fixtureで同じCodex handleのterminal receiptによりgeneration、watch、journalがすべて`faulted`になる。
- Claude／Codex parent callerとSupervisor runtimeの所有権契約を関連testで確認する。

## Rollback

本ADRと対応実装をrevertし、P5-4を再openする。`fault_required`を手動削除する運用には戻さない。
