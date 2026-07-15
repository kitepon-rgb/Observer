# ADR 0110: Claude characterization harnessを受け入れる

日付: 2026-07-16

## Status

Accepted。P5-1b3a非H harnessだけを完了する。live Claude background launch、model request、
job/session/Stop実相関、terminal result、production callerは未完了のまま残す。

## Evidence

- design `280b746`:
  [ADR 0109](0109-claude-public-surface-characterization-contract.md)と
  [専用runbook](../claude-public-surface-characterization-runbook.md)
- Observer implementation `f40b672`:
  `observer-claude-characterization`、isolated settings、Stop capture、agent/session照合、
  terminal exact result照合、owner-only cleanup、5-bin product manifest
- dotagents package verifier adaptation `78c358b`: 5-bin install／verify／rollback契約
- focused: characterization＋product diagnostics 10/10
- related: characterization、product diagnostics、live preflight、Claude model operation、
  Observer AI contract 26/26
- static: `npm run check` green
- package: dry-run 57 files、新しいbin／core収録を確認
- cross-repo isolated install: install／reinstall／verify／rollback green
- actual read-only readiness:
  `status=ready_for_h`、Claude Code `2.1.210`、`reply_surface=unsupported`

## Decision

P5-1b3aを受け入れる。harnessは親Mailbox hookを流用せず、isolated `--settings`へ
characterization専用Stop hookを一件だけ生成する。Stopのraw session IDと
`last_assistant_message`はprocess内でstrict parseしてdigest化し、0600 captureと公開receiptへ
raw job/session/result、account field、host log、config本文を残さない。

同一capture replayだけを冪等にし、別session／別resultは競合として拒否する。cleanupは既知の
`settings.json`／`capture.json`だけを削除し、未知fileがあれば一切削除せずfail loudにする。
Claudeの公開terminal resultが無い場合は`unsupported`を返し、raw `logs`またはprivate job stateへ
fallbackしない。

次はP5-1b3b live Hである。目的、影響、rollbackを示した明示承認前にはClaudeを起動しない。
full regressionと独立重監査はPhase O2完了時に一回だけ行う。
