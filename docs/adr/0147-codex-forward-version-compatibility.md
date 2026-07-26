# ADR 0147: Codex CLIの上位互換versionを受け入れる

日付: 2026-07-26

## Status

Accepted。P5-4 production watchのCodex runtime補正契約とする。

## Context

ObserverはCodex CLIも`codex-cli 0.144.3`完全一致で検証していた。端末の現行
`codex-cli 0.144.6`を拒否するため旧版を隔離利用したところ、bootstrap turnが正常完了しなかった。
Throughlineと同様、exact version固定は互換な上位版を拒否し、古い実行物へ不要に拘束する。

## Decision

1. 最低対応版を`0.144.3`とする。
2. exactな`codex-cli MAJOR.MINOR.PATCH`安定版表現を要求し、最低対応版以上を受理する。
3. prerelease、prefix欠落、不正SemVer、最低対応版未満を拒否する。
4. verification receiptには実Codex CLI versionを保存する。
5. app-serverのinitialize、request／response、thread／turn schema、terminal検証は従来どおりfail closedとする。
6. diagnosticsはexact versionでなく`>=0.144.3`を公開する。

## Acceptance

- 現行Codex CLI 0.144.6がversion gateとapp-server bootstrapを通る。
- 旧版・prerelease・不正表現を拒否する。
- actual versionをverificationへ保持する。
- production watchが旧隔離Codex CLIなしでactiveになる。

## Rollback

本ADRと対応実装をrevertし、P5-4を再openする。旧CLI隔離利用へは戻さない。
