# ADR 0037: cycle／generation exact-once接続を受け入れる

日付: 2026-07-15

## Status

Accepted。host rollover、model operation journal、live provider検証は未完。

## Accepted scope

[ADR 0036](0036-cycle-generation-exact-once-transaction.md)の実装をcommit `3938b28`で受け入れた。

- `prepareCycleInput`をmodel実行から分離し、検証済みinput receiptをgenerationへmodel呼出し前に予約する。
- 新規reservationだけが`processCycle`へ進み、既存reservationは`model_result_unknown`、予算超過は
  `rollover_required`としてcallback未実行で止まる。
- pending journalを`observer.pending_cycle.v2`へ上げ、preparedではinput／resultをnull、processedでは
  digest／exact byte数／result digestだけを保存する。非永続`value`はjournalへ保存しない。
- cursor、generation、pending cleanupを同じtarget lock下で順にcommitし、各write間のcrash recoveryで
  generation budgetを二重加算しない。既に適用済みのgeneration fileは再writeせず、pendingだけを回収する。
- generation state欠損、identity不一致、reservation不一致、cursor不一致を最初のwrite前に拒否する。

## Evidence

- Control: `observer-p4-runtime-20260715` revision 33、worker run
  `observer-cycle-generation-exact-once-run-1` accepted。
- focused gate:
  `node --test test/generation-store.test.mjs test/cycle-store.test.mjs test/supervisor-cycle.test.mjs`
  — 21/21 PASS。
- `npm run check` — PASS。
- 対象5ファイルの`git diff --check` — PASS。
- crash matrixはreservation前、reservation後、processed後、cursor後、generation後をfixtureで確認した。

親受入では、prepared recoveryの無条件停止、不完全一致を許すcompletion fallback、実model-visible入力ではない
silent meter、generation identity未照合、crash証拠不足、古いWorker Report evidenceをimport前に検出した。同じrunで
修正し、最後に親が不足分だけgenerationを書き込む境界を確定してからfocused gateを再実行した。

## Remaining gates

- Claude／Codex固有のterminal stop、terminal receipt確認、次generation start／ready activationの接続。
- model request送信結果不明を解決するmodel operation journal。
- bounded carryover、parent rebind、fault recovery。
- 実provider、アプリ上の単一Observer project表示、live sessionのH受入。

