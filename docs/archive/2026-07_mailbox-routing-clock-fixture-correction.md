# Mailbox routing固定時計fixture訂正

## 状態

完了。P5-1b4d Phase full regressionで再現した独立fixture欠陥を閉じた。

## 問題

`test/mailbox-routing.test.mjs` はpublish／claimへ固定時計 `NOW` を渡す一方、messageを作る
`sealMessage` だけ実時計を使う。そのため固定 `expires_at` を実時間が越えると、routing契約へ到達する前に
`E_MESSAGE_EXPIRED` で失敗する。

## 非目標

- productionのexpiry検証を変更しない。
- expiryを遠い将来の固定日へ付け替えて再発を先送りしない。
- P5-1b4dの実装差分と同じcommitへ混ぜない。

## TODO / 受入条件

- [x] full regressionの2失敗が、`sealMessage`だけ実時計を読むことに起因すると確認する。
- [x] `sealMessage`へpublish／claimと同じ固定時計 `NOW` を渡す。
- [x] focused `node --test test/mailbox-routing.test.mjs` — 3/3 green。
- [x] Phase full regression `npm test` — 393/393 green、fail 0、skip 0。
- [x] 本訂正だけをpathspec明示の独立commitにする。

## Rollback

本訂正commitをrevertする。production契約とstate schemaには変更がない。
