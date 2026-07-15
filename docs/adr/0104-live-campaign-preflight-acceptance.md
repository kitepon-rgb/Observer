# ADR 0104: live campaign preflightを受け入れる

日付: 2026-07-16

## Status

Accepted。P5-1b-preflightだけを完了とする。Claude／Codex public surfaceと
P3-4c／P5-1b live campaignはHのまま残し、実証済みへ昇格しない。

## Evidence

- design `50b4e86`: [ADR 0103](0103-live-campaign-preflight-contract.md)
- implementation `bbe407d`: sanitized versioned receipt、CLI、read-only verifier、
  [live campaign runbook](../observer-live-campaign-runbook.md)
- focused gate: preflight contractとCLIの13/13
- related gate: product diagnostics、Claude runtime、Codex process、hook config、
  CLIを含む40/40
- static gate: `npm run check` green
- actual read-only preflight: macOS arm64、Node 26.5.0でexit 0、top-level
  `h_required`。product、Claude runtime、Codex runtime、hook candidates、
  canonical cwdの5件は`ready`、Claude／Codex public surfaceの2件は
  `h_required`だった。

actual preflightはprovider／app-server、model request、host config read／write、
hook trust、credential、intentional faultを実行していない。receiptには固定version、
check、必須証拠名、H操作名、未実施操作名、収集禁止情報名だけを残し、path、HOME、
username、raw ID、prompt、host log、config本文、token、cookie、credentialを含めなかった。

## Decision

P5-1b-preflightを受け入れる。次の実行可能stepはP3-4c／P5-1b dual-host live
campaignだが、config apply、hook trust、両host一回ずつのmodel request、65秒超wait、
明示停止を伴うためH承認待ちとする。intentional fault trancheは通常campaignから分離し、
別の明示承認なしに実行しない。

full regressionと独立重監査はPhase O2 gateで一度だけ行う。
