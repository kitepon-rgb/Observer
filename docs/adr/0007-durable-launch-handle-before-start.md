# ADR 0007: host handleをstart確認前に耐久化する

日付: 2026-07-15

## Status

ADR 0006のDecision 3、4、6にあるhost action順序を本ADRで訂正する。親所有、同provider、明示起動、
二相transaction、自動respawn禁止という他の裁定は維持する。

## Context

ADR 0006は`starting予約 → host spawn／routing／start follow-up → handle confirm → active`を定めた。
しかしhost spawn成功からconfirmまでに親processが終了すると、Observer stateはhandleなしの`starting`のまま残り、
実際のCodex agent／Claude jobだけが動き続ける。親threadの一時的なcontextにhandleがあっても、crash recoveryの
耐久証拠にはならない。停止結果が不明なまま`faulted`へ閉じてhandleを消すことも、孤児回収を不能にする。

## Decision

1. watch stateへ`launching`を追加する。`launching`はlive statusで、provider固有launch handleをprivate stateへ持つ。
   公開statusはhandleを含めない。
2. 安全な起動順序を次へ固定する。
   - 明示authorization検証
   - handleなしの`starting`予約
   - 親hostによるchild spawn
   - spawn receiptとrequest identityを照合し、`starting → launching`としてhandleをatomic保存
   - Codex routing／start follow-up、またはClaude job cwd／name／stateの確認
   - 同じhandleを再照合して`launching → active`
3. host spawn前の失敗だけはhandleなしの`starting → faulted`で閉じてよい。
4. handle保存後のrouting、dispatch、job相関、start確認失敗では`launching → stopping`へ進め、private handleを保持する。
   親はhost正式停止入口を実行し、同じhandleの停止確認後だけ`stopping → faulted`へ閉じる。
   stop失敗／結果不明では`stopping`を保持し、faultedまたはstoppedへ丸めない。
5. 利用者の明示停止は`launching`と`active`の双方から`stopping`へ進められる。確認後は通常の`stopped`へ閉じる。
   launch失敗cleanupと利用者停止は、同じhandle相関を使うが終端statusを混同しない。
6. `activateWatch`は`starting`からhandleを受け取って直接activeへ進む旧入口を廃止する。
   `attachWatchLaunchHandle`で`launching`へ進めた後、同じhandleを指定するactivateだけを受理する。
7. handle保存後のparent crashは、公開status `launching`または`stopping`とprivate handleから明示回復する。
   PID、mtime、TTLによる自動停止／takeover／respawnは追加しない。

## Consequences

- host spawn直後に親が落ちても、停止に必要なhandleをObserver stateから回収できる。
- 「Observerが起動済み」と「host childは存在するがstart確認前」を公開statusで区別できる。
- watch-store、parent-launch core、fixtureを同じF変更として更新する必要がある。
- 既に公開利用者のないpre-v1コードなので旧`activateWatch(starting, handle)`互換は維持しない。
