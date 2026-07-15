# ADR 0094: host-neutral core E2Eを受け入れる

日付: 2026-07-16

## Status

Accepted。P5-1aの非H core E2Eと、そこで再現したprovider cleanup replay欠陥を受け入れる。
P5-1全体、Claude production delivery、両host live E2Eは未完のまま維持する。

## Evidence

- design: `14b57ac`、[ADR 0092](0092-host-neutral-core-e2e-contract.md)
- corrective design: `a168e59`、[ADR 0093](0093-provider-cleanup-replay-binding.md)
- corrective implementation: `ddd768a`
- core E2E: `e203190`、cooldown extension `f6b296b`
- focused E2E: 6 pass / 0 fail / 0 skip
- corrective focused: Supervisor production 6/6、失敗scope crash replay 1/1
- related: 178 pass / 0 fail / 0 skip
- static: `npm run check`、scoped `git diff --check` green

## Accepted behavior

- 実target／watch／generation／cycle／model operation／semantic decision／Mailbox／parent Stop stateを
  同じowner-only rootで接続し、Codex completed cycleを一件の親advisoryまで貫通した。
- `no_advisory`とevidence不適格suppressionはcursorだけをcommitし、Mailboxを作らない。
- 同じwatchの二cycleで、60分内の同一dedupe／同severity／新evidenceを
  `accepted -> suppressed`へ収束させ、親配送を合計一件に保った。
- provider accepted後の再入、Mailbox publish直後のcrash、二回目の親Stopを、別model requestや
  duplicate messageなしでexact replayした。
- 誤providerはclaimせず、claim後のstdout失敗は`delivery_unknown`へ回収して本文を再配送しない。
- Claude runtime未実証はThroughline wait、pending cycle、model journal、semantic decision、Mailboxの
  変更前に`provider_unavailable`を返す。Claude成功やCodex fallbackをfixtureで捏造していない。

## Corrective receipt

provider journal cleanup後・generic applied前のcrashでは、production callbackがgeneric `completed`の
provider receipt digestとcompleted output digestを既存cleanup APIへexactに渡すよう補正した。
provider journal欠損時の許可条件は緩めず、operation IDまたは二digest不一致の拒否を維持する。

## Remaining

- P5-1bでClaude／Codexの実completed証拠、production model request、session相関、hook trust、
  65秒超wait、実host fault／停止をH承認下の一campaignで受け入れる。
- P5-1親TODO、P4-4 dogfood、Phase O2監査、full regressionは閉じない。
