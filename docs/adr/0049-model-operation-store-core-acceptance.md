# ADR 0049: model operation journal coreを受け入れる

日付: 2026-07-15

## Status

Accepted

## Context

[ADR 0047](0047-model-operation-journal-contract.md)は、model requestの送信結果不明をhost lifecycleから分離し、
`prepared -> reserved -> dispatching -> accepted -> completed -> applied`の一方向journalで回収する契約を固定した。
Control `observer-p4-provider-binding-20260715`はhost-neutral store coreを専用worktreeへ配置した。

## Decision

1. commit `4c3cc03`のmodel operation store coreを受け入れる。
   - generation reservation前に決定的operation IDを持つ`prepared`を0600で耐久化する。
   - matching generation／reservationだけを`reserved`へ進め、`dispatching`をdurable化した後の再dispatchを拒否する。
   - `accepted`はprovider固有raw handleでなくreceipt digestだけを保存する。
   - `completed`は16 KiB以下のstrict parse済みcanonical `observer.ai_output.v1`本体とdigestを保存する。
   - `applied`はexact `observer.cycle_result.v1`本体を保存し、同一resultだけを冪等に回収する。
   - status別のnull関係、UTC timestamp／非後退、identity conflict、private lockをfail closedに検証する。
   - 通常cleanupは`applied`、planned rollover cleanupは未送信`prepared`だけに限定する。
2. 初回親レビューで、`applied`がdigestだけを保存してexact resultを再利用できない点、status関係と時刻検証、
   acceptance fixtureの不足を検出した。同じ2pathとfocused scope内で修正し、旧reportは採用しなかった。
3. 親の統合時に専用worktreeと本線の2ファイルSHA-256完全一致を確認した。
4. focused gateを受け入れる。

   ```text
   node --test test/model-operation-store.test.mjs
   ```

   結果は8件成功、失敗・skip・cancel・todo各0だった。`npm run check`とscoped `git diff --check`も成功した。
5. full suite、live Claude／Codex、network、credential、app UI、publish、pushは実行しておらず、Phase gate／H gateへ残す。

## Consequences

- Supervisorはgeneration reservationより先にhost-neutral operationを作り、dispatching以後を再送せず回収できる。
- exact provider result read、Supervisor issue／recover／apply統合、Mailbox exact replayは後続TODOとして残る。
- このADRをControl Task `observer-model-operation-store-core`のfinalization Decision証拠に使う。
