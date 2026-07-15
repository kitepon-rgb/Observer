# ADR 0103: dual-host live campaignをread-only preflightへ束縛する

日付: 2026-07-16

## Status

Accepted for implementation。provider起動、model request、host設定変更、hook trust、
credential／login、意図的faultは実行しない。

## Context

Observerの非H core、public watch、MCP diagnostics、clean install、性能／cleanupは
受け入れ済みである。残るP3-4c／P5-1bはClaude／Codexのlive host、session相関、
hook trust、65秒超wait、明示停止を同じcampaignで実証するH gateである。

preflightなしにHへ進むと、version不一致、package不整合、hook候補不正をlive変更後に
発見し、fixture成功をlive成功へ誤昇格させる。逆にpreflightでprovider surfaceまで
成功扱いすると、未起動のapp-server／background jobと実hook ackを偽装する。

## Decision

1. 公開入口を次へ固定する。

   ```text
   observer campaign preflight --claude-command <absolute-path> \
     --codex-command <absolute-path>
   ```

   command pathはabsolute regular executableを既存runtime verifierが確認する。
   runtime rootは実行中Observer package自身へ固定し、argvで差し替えない。
2. preflightは次だけをread-onlyで行う。
   - `observer diagnostics`と同じproduct manifest／package integrity検証
   - Claude CLI 2.1.210、Observer MCP 0.0.0、read-only MCP tool surface検証
   - Codex CLI `codex-cli 0.144.3`とcanonical Observer cwd検証
   - Claude／Codex別parent Stop hook fragment候補の生成検証
3. Claude background `agents --json`、Codex app-server initialize、model request、
   host config read／write、hook trust、credential stateはpreflightで触らない。
4. 成功resultは`observer.live_campaign_preflight.v1`とし、top-level statusを
   `h_required`にする。静的checkがgreenでも`ready`やlive成功へ昇格しない。
5. checkはproduct、Claude runtime、Codex runtime、hook candidates、canonical cwd、
   Claude public surface、Codex public surfaceの固定順とする。前五件は`ready`、
   後二件は`h_required`を正常形とする。
6. known prerequisite failureは同schemaの`blocked`、固定check名、Observer error code、
   後続`not_checked`を返してexit 1にする。raw error、path、digest、stdout、stderrを返さない。
   unknown failureは既存CLI errorでfail loudにする。
7. receiptはproduct version、固定check、campaign必須証拠名、H操作名、未実施操作名、
   収集禁止情報名だけを持つ。absolute path、HOME、username、raw session／thread／job ID、
   prompt、host log、config本文、token、cookie、credentialを含めない。
8. runbookは両host各一回の順序、成功条件、即時停止条件、失敗時の同handle回収、
   config backup／rollback、収集禁止情報を固定する。意図的fault trancheは通常campaignから
   分離し、追加のH承認なしに実行しない。

## Acceptance

- focused: exact `h_required` receipt、known blocked、unknown failure、CLI parse／exit。
- related: product diagnostics、Claude runtime、Codex process verifier、hook config、CLI。
- 実commandでpreflightを一回実行し、provider起動や設定変更なしの結果を受け入れる。
- static: `npm run check`。
- full regressionと独立重監査はPhase O2 gateへ残す。
