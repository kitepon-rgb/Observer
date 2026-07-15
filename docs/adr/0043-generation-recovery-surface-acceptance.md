# ADR 0043: generation recovery surfaceを受け入れる

日付: 2026-07-15

## Status

Accepted。provider binding本体とlive provider検証は後続gateに残す。

## Accepted implementation

- 実装commit: `eece56d`（`feat: Observer世代の回復境界を実装`）
- Control: `observer-p4-provider-binding-20260715` revision 13
- Worker Run: `observer-generation-recovery-surface-run-1`
- Worker Report result digest: `c703caa66fec74718b383d747feefd0a5abc5d3e73f54847aeab97eebee0c456`

host-neutral lifecycleは、provider、watch／target、journal status、from／to generation、次actionだけを返す
`observer.generation_host_recovery_context.v1`を公開する。previous／next raw handle、receipt本文、launch request本文は
返さない。`terminal_observed`以降はcallerのvalid launch requestをdigestで固定し、別runtime root／cwdへの
差替えを拒否する。

Codex runtimeはgeneration ID namespaceを必須にするspawn／activate／spawn recovery／ready recoveryを持つ。
rollover用APIは初回watch用の`confirmParentHostSpawn`／`confirmParentLaunch`を呼ばない。provider journal欠損、
`thread_start_unknown`、`turn_start_unknown`を未送信と推測せず、新しいthread／turnを再送しない。readyは耐久化した
同一thread／turnが`inProgress`と再観測できた場合だけ返す。

## Verification

- 変更前baseline: focused 25/25 PASS、`npm run check` PASS
- fixture先行: production未変更時に未実装exportで期待どおりfail
- Worker gate: focused 32/32 PASS、`npm run check` PASS、4 pathの`git diff --check` PASS
- 親受入: focused 32/32 PASS、`npm run check` PASS、4 pathのdiff digestとWorker Report result digestが一致
- Worker Reportの手補正、証拠再構成、代替回収: なし

## Deferred

- Claude／Codex commandをhost-neutral lifecycleへ接続するprovider binding
- model request送信結果不明を扱う独立operation journal
- live Claude／Codex、network、credential、app UI、65秒超waitを使うH受入

