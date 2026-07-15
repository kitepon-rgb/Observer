# ADR 0040: generation host rollover coreを受け入れる

日付: 2026-07-15

## Status

Accepted。provider別binding、model operation journal、live Claude／Codex受入は未完。

## Accepted scope

[ADR 0038](0038-generation-host-rollover-transaction.md)のhost-neutral coreとprovider recovery補助を
commit `9b003e6`で受け入れた。

- active watchを閉じず、privateな短命journalで
  `stop_authorized → terminal_observed → spawn_authorized → spawn_observed → ready_observed`を単調遷移する。
- journalをhost commandより先に保存し、旧terminal確認前のnext generation開始と、spawn receipt保存前の
  watch handle交換を拒否する。
- spawn receipt保存後にactive watchのprivate handleを旧→新へCASし、ready receipt照合後だけgenerationを
  activeへ進めてjournalを削除する。
- terminal／spawn／readyのhandle、provider、watch、targetをexact照合し、crash後は同じreceiptで不足分だけを
  冪等適用する。public watch／generation stateへraw handleを出さない。
- Codex host journalをgeneration IDでnamespaceし、Claude recoveryはterminal履歴を候補から除外して、
  複数live候補をfail closedにする。
- next-start認可時はlaunch request本文を保存せず、bounded canonical digestだけをjournalへ固定する。
  認可後のretryで別runtime root／cwdへ差し替える試みは`E_GENERATION_HOST_LAUNCH_REQUEST_CONFLICT`で拒否する。

## Execution fallback

native implementerは実装差分を作る前にprovider capacityで終了した。Control revision 40へterminal failureを記録し、
[ADR 0039](0039-generation-host-rollover-executor-fallback.md)に基づいて、同一Taskをexecution-verified aiterm Codexへ
一回だけfallbackした。二つのworkerを同時実行せず、run-1由来のworkspace差分がないことを確認してからrun-2を開始した。

## Evidence

- Control: `observer-p4-runtime-20260715`。
  - `observer-generation-host-rollover-core-run-1`: revision 40で`failed`。
  - `observer-generation-host-rollover-core-run-2`: revision 45でstrict Worker Report import、revision 46でaccepted。
- focused gate:
  `node --test test/generation-host-lifecycle.test.mjs test/watch-store.test.mjs test/claude-host-adapter.test.mjs test/codex-host-runtime.test.mjs test/generation-store.test.mjs`
  — 40/40 PASS。
- `npm run check` — PASS。
- 対象8 pathの`git diff --check` — PASS。

親受入では、初回next-start認可のlaunch requestがjournalへ相関されず、crash recovery時に別のvalid
runtime rootへ差し替えられる欠陥をReport import前に検出した。同じrunでlaunch request digestと差替え拒否fixtureを追加し、
親がfocused gateを一回再実行して受け入れた。

## Remaining gates

- record-first coreが返すstop／start authorizationをClaude／Codex host commandへ結ぶprovider別binding。
- model request送信結果不明を解決するmodel operation journal。
- bounded carryover、parent rebind、fault recovery。
- 実provider、アプリ上の単一Observer project表示、live sessionのH受入。
