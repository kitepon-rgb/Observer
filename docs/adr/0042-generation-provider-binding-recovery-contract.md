# ADR 0042: generation provider bindingをrecovery surface先行で実装する

日付: 2026-07-15

## Status

Accepted for implementation。fake Claude/Codex fixtureを先行し、live providerはH gateに残す。

## Context

[ADR 0040](0040-generation-host-rollover-core-acceptance.md)でrecord-firstなhost-neutral journalは完成したが、
provider commandを呼ぶbindingは未実装である。既存のCodex `activateCodexObserver`／`recoverCodexObserverReady`は
初回watchを`launching → active`へ進めるため、rollover中の既にactiveなwatchへ流用できない。

また、coreが`spawn_observed`まで進んだ後は`authorizeNextGenerationHostStart`を再度呼べず、外側がraw handleを
読まずに「spawn回収」「ready回収」のどちらを行うべきか判断する公開surfaceがない。

## Decision

1. provider bindingの前に、host-neutral recovery contextを追加する。公開値はschema、provider、watch／target、
   journal status、from／to generation IDとsequence、必要な次actionだけとし、previous／next raw handle、
   receipt本文、launch request本文を出さない。
2. `terminal_observed`以降のcontext読取はcallerのvalid launch requestを要求し、journalの
   `launch_request_digest`とexact一致した時だけ返す。別runtime root／cwdでは回復情報も返さない。
3. recovery actionは次のallowlistに固定する。
   - `stop_authorized`: `observe_terminal`
   - `terminal_observed`: `authorize_start`
   - `spawn_authorized`: `recover_spawn`
   - `spawn_observed`: `recover_ready`
   - `ready_observed`: `finish_activation`
4. Codex runtimeへgeneration専用境界を追加する。thread／turn journalはgeneration ID namespaceを必須とし、
   rolloverでは`confirmParentHostSpawn`／`confirmParentLaunch`を呼ばない。spawn receiptはthread IDが耐久化済みの時だけ、
   ready receiptは同じturnが`inProgress`と再観測できた時だけ回収する。
5. `thread_start_unknown`はcwd singleton等へ推測attachせずunknownのまま止める。`turn_start_unknown`も別turnを開始しない。
   provider journalが存在しない`recover_spawn`は「command未実行」と推測して再spawnせず、明示的unknownを返す。
6. Claudeはdeterministic name／canonical cwdのlive候補だけを回収し、複数live候補を拒否する既存契約を使う。
   terminal履歴を新spawn候補にしない。
7. recovery surface完了後、別TaskでClaude／Codex bindingを実装する。bindingはcoreのactionに従い、
   `issue_once`以外では新しいstop／spawn commandを送らない。
8. model request送信結果不明のjournalはhost lifecycleと状態・lock・受入を分離し、別Taskで実装する。

## Crash policy

- core authorization後・provider journal前: unknown。自動spawnしない。
- provider journal作成後・command結果前: provider journalからだけ回収する。
- spawn receipt後・watch CAS前: coreの同一receipt再適用でCASだけ回復する。
- turn start後・ready前: generation namespaceの同一thread／turnからreadyだけ回収する。
- ready後・activation cleanup前: coreの同一ready再適用でactivation／cleanupだけ回復する。

## Rejected alternatives

- 初回watch用Codex activationへdependency injectionで偽のwatch遷移を渡す案: productionでtest seamを制御フローに使う。
- coreのprivate journalをbindingが直接読む案: raw handleとlifecycle正本の所有境界を破る。
- provider journal欠損を「未送信」とみなしてspawnする案: crash位置を証明できず二重起動になる。
- model operation journalを同じhost journalへ追加する案: host世代とcycle送信結果の正本を再結合する。
