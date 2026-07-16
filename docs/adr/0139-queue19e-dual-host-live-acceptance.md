# ADR 0139: queue 19e dual-host live acceptance

日付: 2026-07-16

## Status

Accepted。

## Scope

オーナーが明示承認した通常系queue 19e dual-host live Hを、campaign candidateだけで実行した。
intentional crash、通信断、credential／login、push、publish、deployは実施していない。

## Accepted evidence

### Claude

- Aitermの公開`claude_agent`／同一PTY follow-up／exact result／`pty_close`を使用した。
- 親completed feed 2件と同じObserver generationのcompleted cycle 2件を確認した。
- 初回cycle後65秒超を維持し、pending reservation／cycle／model operation残留は無かった。
- callerはSIGINTで`cancelled`／exit 130、managed session残留0、親sessionは公開closeで`closed`となった。

### Codex

- 公開app-server parentとObserver production callerを使用した。
- bootstrap turnの`completed`後だけreadyとなり、親completed feed 2件と同じObserver generationの
  completed cycle 2件を確認した。
- 初回cycle後65秒超を維持し、pending reservation／cycle／model operation残留は無かった。
- callerはSIGINTで`cancelled`／exit 130、managed app-serverと親app-serverはterminal、
  local process残留0。

### Closure

- Claude／Codexのcampaign projectは空のままで、fingerprintを変更していない。
- 最初のconfig archiveから両provider設定を復元し、archiveと現物のdigest、mode 0600、uid 501、
  gid 20が一致した。candidate dry-runは両providerで`changed=yes`となり、candidate設定が残っていない。
- raw session／thread／turn ID、prompt、model output、credentialは証拠へ保存していない。

## Defects closed during the campaign

- Throughline Stop transcript flush barrier: `a46b915`。
- Aiterm initial TUI ready stabilization: `4d3befd`。
- Observer Aiterm／Codex child signal isolation: `396cf05`／`b044690`。
- Observer per-cycle exact output contract: `ebd8ae6`。
- Observer Codex bootstrap terminal ready gate: `9eb4a7e`。
- Throughline concurrent writer gate: `95a3233`、live acceptance `0366bb8`。

これらは失敗attemptを成功へ数えず、所有repoの独立gate・独立commit後にfresh runで再受入れした。
