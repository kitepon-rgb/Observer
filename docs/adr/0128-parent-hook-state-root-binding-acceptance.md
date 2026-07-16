# ADR 0128: parent hook state root束縛修理を受け入れる

日付: 2026-07-16

## Status

Accepted。P5-1b5b-r1だけを完了し、dual-host live成功には昇格しない。

## Evidence

- 実Claude attemptはmodel応答後、旧hookの`E_PERMISSION_INVALID`とcompleted feed 0件を確認し、
  Aiterm公開`pty_close`でterminalへ閉じた。raw ID、prompt、host log、設定本文は保存していない。
- `observer-hook-config`はstate root指定時の両provider canonical command、旧rootのnoncanonical判定、
  invalid path拒否を固定した。
- live preflight CLIはstate rootを必須とし、公開fragment内の同一root束縛を検証する。
- focused 28/28、related 48/48、`npm run check`、runbook／ADR markdown lintはgreen。
- dotagentsのisolated package install／reinstall／verify／rollback gateも、新しいCLI引数でgreen。

## Acceptance

ADR 0127の契約を受け入れる。次の実行可能stepは、Observer candidateの再pack／再install、
同じcampaign state rootを渡したactual preflightとhook config再適用、その後のqueue 19e再開である。
intentional fault、credential/login、push、publish、deployは未実施のまま維持する。
