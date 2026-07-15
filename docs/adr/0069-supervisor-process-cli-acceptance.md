# ADR 0069: Supervisor external process／CLIを受け入れる

日付: 2026-07-16

## Status

Accepted。commits `77cbae4`、`4e29398`、`6d03b71`、`96ccad7`とcorrective commits
`dda8567`、`f7efa09`を、ADR 0066〜0068のfake-process境界で受け入れる。
実Codex model request、実Throughline長時間wait、Claude deliveryは完了扱いにしない。

## Accepted behavior

- target固有process leaseをapp-server生成前からterminal cleanup後まで保持し、一step lockと責務分離する。
- timeout／committedは同一process／同一initialized Codex sessionで次stepへ戻り、model pendingだけをbounded pollする。
- `model_result_unknown`は永久pollや別requestへfallbackせずterminal faultにする。
- active watchのstopping／stopped／faulted、外部AbortSignal、provider terminationを区別し、進行中Throughline waitへ
  cancelを伝播する。watch/provider identity変化はfail loudにする。
- Throughline 0.6.3とCodex CLI 0.144.3をabsolute executable／owner／mode／identity／versionへ束縛し、
  app-server connectionは一度だけinitializeする。
- Codex childはSIGTERM後のcloseを待ち、grace超過ではSIGKILLする。terminal不明、initialize失敗、cleanup失敗を
  successへ丸めない。
- `observer supervisor run`は既存registered targetだけを使い、watch、runtime root、absolute command、bounded
  timeout/poll、approved plan refへ束縛する。stdout terminal result、stderr sanitized error、cancel exit 130を固定する。

## Verification

- final related: Supervisor process／runtime／transport／host session／one-step／cycle、Throughline client、CLI／targetの
  70 PASS / 0 FAIL / 0 SKIP。
- static: `npm run check`、`git diff --check` PASS。
- correction前の68件gateは最終HEADの受入証拠へ流用せず、ADR 0067／0068反映後に上記70件を再実行した。
- full regressionはPhase O2 gateまで未実行。live host request、credential、network、publish、deployは未実行。

## Remaining

- Codex live app-serverでcycle turn／exact result／65秒超wait／explicit stopをH gateとして実証する。
- Claude公開非対話delivery、session相関、isolated Stop captureを実証・接続する。
- planned rollover、parent rebind、fault recoveryをprovider lifecycleへ統合する。
