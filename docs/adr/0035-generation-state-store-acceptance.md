# ADR 0035: generation state storeを受け入れる

日付: 2026-07-15

## Status

Accepted。Task受入と実装コミットのimmutable証拠として使用後は変更しない。

## Context

Control `observer-p4-runtime-20260715`は、Task `observer-generation-state-store`をexecution-verifiedな
native implementerへ一件だけ配置した。Workerは委譲packetとstrict Worker Report skeletonをdispatch前に受け取り、
書込scopeを`src/generation-store.mjs`と`test/generation-store.test.mjs`の二ファイルへ限定した。

実装はwatch認可と分離したgeneration state、model呼出し前のexact input reservation、8 completed cycle／
262,144 UTF-8 bytesのhard ceiling、terminal確認後だけのsequence進行をrecord-onlyで提供する。stateには
raw host handle、raw parent thread、会話、prompt、model output、tool logを保存しない。

## Decision

親のpre-import reviewで、無効初期化による空directory作成、initialize／begin／activateの応答喪失再試行、
generation ID・status・timestamp・budget relationshipのfail-closed検証、実8-cycle境界testの不足を確認し、
同一Run内で修正した。その後、strict Worker Reportとimport envelopeの完全一致を確認し、Worker Reportを
手補正せずControl revision 24へimportした。親は実diffと受入契約を確認し、次のgateを一度再実行した。

- `node --test test/generation-store.test.mjs test/watch-store.test.mjs test/parent-launch.test.mjs`: 24/24 passed
- `npm run check`: passed
- `git diff --check -- src/generation-store.mjs test/generation-store.test.mjs`: passed

Control revision 25でRunをacceptし、二ファイルだけをcommit `9a2b899`へ固定した。cycle cursor commitとの
exact-once transaction接続、host stop／次generation start、model request、live session、full suiteは
このTaskの非目標どおり実行していない。

## Consequences

- generation lifecycleとbudget reservationのdurable storeは完了とする。
- 次Taskはcycle store／Supervisorとのexact-once接続であり、reservationなしのmodel実行と二重budget加算を拒否する。
- host rolloverが未接続の間、threshold到達は新世代を暗黙起動せず`rollover_requested`で止まる。
