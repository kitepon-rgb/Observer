# Observer core E2E history順序fixture訂正

完了。fixture訂正はcommit `a400995`、P5-1b4d最終Phase fullは393/393 green。

## 目的

P5-1b4d Phase full regressionで再現したadvisory cooldown E2Eの順序誤仮定を、製品のcanonical history
sortを変えずに訂正する。

## TODO

- [x] 同じ`NOW`でfinalizeした二entryの配列順へ依存せず、初回cycle直後が`accepted`であることを確認する。
- [x] 二回目cycle後に`accepted`と`suppressed`が各一件存在し、cursorとMailbox一件の既存受入を維持する。
- [x] failure scope testを一度通した（1 passed、0 failed、0 skipped）。`npm run check`もgreen。
  独立commit後、full regressionはP5-1b4d Phase gateへ戻って一度だけ再取得する。

## 非目標

- `compareHistory`、semantic decision、cooldown、retention、Mailbox挙動を変更しない。
- live request、publish、pushを行わない。
