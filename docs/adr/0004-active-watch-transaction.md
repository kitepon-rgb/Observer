# ADR 0004: 一target一active watchのtransactionと明示回復

日付: 2026-07-15

## Context

親launcherはprovider childを起動する前にwatchを確保しなければならない。単なるPID file、mtime、TTLでは、
起動途中のcrash、二親からの同時起動、古い親の遅延操作を安全に区別できない。一方、停止時には
provider固有のchild handleが必要であり、別の親threadからも明示停止できる必要がある。

## Decision

1. stateはObserver所有rootの`watches/<target_id>/current.json`へowner-onlyで保存する。working tree、
   Throughline、Claude、Codexの管理領域へ置かない。
2. lifecycleは`starting → active → stopping → stopped`、またはlive状態から`faulted`とする。
   `starting`／`active`／`stopping`のいずれかが存在するtargetへのstartは`E_WATCH_ALREADY_ACTIVE`で拒否する。
3. 全遷移はtarget単位のprivate transaction lock内で、`watch_id`と期待statusを照合してatomic replaceする。
   `stopped`／`faulted`からの再startも、callerが直前に読んだ`expected_previous_watch_id`との一致を要求する。
   遅延した古い親の操作で新しいwatchを上書きしない。
4. start予約は新しいrandom `watch_id`、target、provider、`starting`だけを先に保存する。provider childの
   起動に成功してprivate launch handleを得た後だけ、同じ`watch_id`を`active`へ遷移させる。
5. launch handleは停止に必要な最小のprovider固有opaque値だけをprivate stateへ保存する。親session／thread ID、
   prompt、credential、tokenは保存しない。status表示と公開resultからhandleを除外する。
6. 明示stopは現在の`watch_id`を`stopping`へ遷移し、provider adapterでchild停止を確認した後に
   `stopped`へ閉じる。stop失敗を`stopped`へ丸めない。
7. launch失敗、child異常終了、cycle hard failureでは固定`fault_code`とともに`faulted`へ遷移し、
   Stop continuationと自動再起動を止める。raw exception、stderr、turn本文をstateへ保存しない。
8. transaction lockの残留は、観測したowner nonceを指定する明示回復だけで除去する。PID生存確認、mtime、
   TTL、provider quotaからlockまたはactive watchを自動奪取しない。
9. `watch status`はhandleを含まないsanitized current stateを返す。再start、stop、lock回復はいずれも
   ユーザーの明示指示を受けた親の操作として行う。

## State boundary

private current stateは少なくとも次を持つ。

- schema、watch_id、target_id、canonical project_root
- provider（`codex`／`claude`）、status
- created_at、updated_at
- live状態だけのprivate launch handle、またはfaulted状態だけの固定fault_code

公開statusへはlaunch handleを投影しない。

## Consequences

- provider childを起動してから競合に気づく二重起動窓を閉じられる。
- 元の親threadが無くても、owner-only stateから同provider adapterで明示停止できる。
- crashや残留lockを時刻推測で自動修復せず、状態不明を利用者へ明示できる。
