# ADR 0054: Supervisor model operation統合を受け入れる

日付: 2026-07-15

## Status

Accepted。Supervisorをmodel operation journalの`issue`／`recover`／`apply`／`finalize`境界へ統合した。

## Decision

1. commit `c226cc9`のSupervisor統合を、ADR 0050とADR 0051の実装として受け入れる。
2. generation reservationより先に`prepared` journalを作り、record-firstの`dispatching`保存後だけ`issueModelOperation`へmodel inputを渡す。
3. `dispatching | accepted`の回収は`recoverModelOperation`だけを呼び、model inputや`value`を再供給しない。provider結果が不明なら再送せず`model_result_unknown`を返す。
4. provider callbackはexact schemaの`accepted | pending | completed | unknown`だけを受け入れる。`completed`もdurable provider receiptを`accepted`へ保存してからcanonical outputをjournalへ移す。
5. `completed -> applied -> finalize -> cycle processed -> model cleanup -> cycle commit`の順を固定し、`applied`回収ではapplyを再実行しない。
6. processed cycle回収はmatching `applied` journalだけをfinalize／cleanupし、journalなしだけを既存cycle commitへ進める。target／watch／generation／cycle／input／bytes／resultの不一致はfail closedにする。
7. planned rolloverでは未送信`prepared`だけをcleanupする。旧generationの`prepared`はstoreのexact current-generation置換を使い、`reserved`以降を再prepareしない。

## Verification

- Worker focused: `node --test test/supervisor-cycle.test.mjs` — 15件成功、失敗0、skip 0。
- TODO related: `node --test test/supervisor-cycle.test.mjs test/model-operation-store.test.mjs test/cycle-store.test.mjs test/generation-store.test.mjs test/watch-cycle.test.mjs` — 47件成功、失敗0、skip 0。
- static: `npm run check` — 成功。
- scoped: `git diff --check -- src/supervisor-cycle.mjs test/supervisor-cycle.test.mjs` — 成功。
- Control `observer-p4-provider-binding-20260715`の初回Reportは、revision 55で実時刻より約33分未来の証拠時刻を受理したためrevision 56でrejectした。dotagents `d6702b6`で5分clock-skew検証を実装後、同一assignmentのretry Reportをrevision 60に正時刻でimportし、revision 61で親acceptした。
- retry worktreeとmainの2ファイルはSHA-256でbyte-exactだった。full regression、live provider、network、credential、app UI、意図的障害試験は本TODOでは実行していない。

## Consequence

Supervisorのhost-neutral crash matrixは閉じた。次のready TODOは、Claude／Codex provider固有journalからexact operation resultを再送なしで読み、ここで定義したcallbackへ接続することである。
