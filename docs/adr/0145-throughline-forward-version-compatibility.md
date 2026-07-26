# ADR 0145: Throughlineの上位互換versionを受け入れる

日付: 2026-07-26

## Status

Accepted。P5-4のversion gate補正契約とする。

## Context

Observer 0.1.0はThroughlineを`0.6.3`完全一致で検証していた。しかしnpm公開版
Throughline 0.6.3には、Observer production runtimeが必須とする`observer-read`／
`observer-wait`がない。一方、端末のThroughline 0.8.7は同じv1 wireを実装しているが、
完全一致gateによりprovider起動前に拒否された。

exact version固定は、互換な上位版を拒否する一方、固定版に必要capabilityがあることも保証していない。

## Decision

1. 最低対応版を、必要な公開CLIを持つ`0.8.7`とする。
2. `MAJOR.MINOR.PATCH`の安定版SemVerだけを受理し、実versionが最低対応版以上ならversion gateを通す。
3. prerelease、build metadata、prefix付き、不正SemVer、最低対応版未満はfail closedで拒否する。
4. verification receiptには最低版でなく実行物が返したactual versionを保存する。
5. preflightとverified clientはactual versionを同じrange契約で再検証する。
6. diagnosticsはexact versionでなく`>=0.8.7`を公開する。
7. version gate通過をprotocol互換の証拠にしない。`observer-read`／`observer-wait`の
   JSON-only、schema、status、cursor検証を従来どおり必須にする。

## Acceptance

- `0.8.7`と上位安定版を受理する。
- `0.8.6`、prerelease、不正表現を拒否する。
- actual versionがverificationへ残る。
- preflightは上位版verificationとv1 read wireを受理する。
- 実Throughline 0.8.7でproduction parent callerがversion gateを越える。

## Rollback

本ADRとP5-4実装commitをrevertし、P5-4を再openする。機能を持たない0.6.3完全一致へは戻さない。
