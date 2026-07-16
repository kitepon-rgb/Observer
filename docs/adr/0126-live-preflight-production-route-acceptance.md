# ADR 0126: production route live preflightを受け入れる

日付: 2026-07-16

## Status

Accepted。P5-1b5aだけを完了とし、dual-host live成功には昇格しない。

## Evidence

- Observer implementation `8ec586a`: Throughline実`observer-read`、Aiterm stdio
  initialize／exact tool schema、Codex runtime、Stop hook候補を固定順preflightへ接続した。
- Observer manifest `72bb620`: production依存をAiterm 0.14.0へ更新した。
- dotagents `d304566`: hook configの原子的`--restore`、元absent、mode／uid／gid、
  途中失敗rollbackを実装した。
- dotagents `8eb75db`: installed Observer verifierをAiterm依存へ追従した。
- focused: preflight／CLI 20/20、product manifest 4/4。
- related: preflight、CLI、Throughline client／runtime、Aiterm／Codex transport、product
  diagnostics 46/46。
- static: `npm run check` green。runbook／ADR markdownlint 0 error。
- isolated package: install、reinstall、verify、uninstall／rollback green。
- campaign-local package SHA-256:
  - Observer: `ec1d5d009b503e6d725d4a55eb803fdccb655de86d13d45e7d7558ec2ac91a5d`
  - Throughline: `c64d492e007df0860590c73b4b774849993e8380dfddeede3ea3523fdd0e0fcb`
  - Aiterm: `c61ef999fcc5b2ecb20d3e4157d66b6fbd51e951ae8ad8588030a1be4b0ee4de`
- actual read-only preflight: product、Throughline、Aiterm、Codex、hook candidates、
  canonical cwdが`ready`、Claude／Codex public surfaceだけが`h_required`、
  `blocked=null`。

actual preflightはprovider launch、model request、host config read／write、hook trust、
credential、intentional faultを実行していない。旧global packageのsurface不足は同version
candidateへのfallbackで隠さず、受入済みrepo HEADのcampaign-local packageへ固定した。

## Decision

[ADR 0125](0125-live-preflight-production-route-correction.md)を受け入れ、P5-1b5aを
完了する。次は承認済み通常系P5-1b5bで、各host一回のsession launch、初回／follow-up、
65秒超wait、通常停止、hook config restoreを実証する。intentional crash／通信断は
別承認のため実施しない。

## Rollback

Observer `8ec586a`／`72bb620`とdotagents `d304566`／`8eb75db`を各repoで独立revertし、
P5-1b5をblockedへ戻す。旧background job preflightやglobal旧packageでliveを続行しない。
