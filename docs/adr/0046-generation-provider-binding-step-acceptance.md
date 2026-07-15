# ADR 0046: generation provider binding stepを受け入れる

日付: 2026-07-15

## Status

Accepted

## Context

[ADR 0044](0044-generation-provider-binding-step-contract.md)は、generation provider bindingを
Codexのread-only terminal観測とhost-neutralな一command一step machineへ分離した。
Control `observer-p4-provider-binding-20260715`は両Taskを専用worktreeへ配置し、非交差scopeで実装した。

## Decision

1. commit `b06a847`の`observeCodexGenerationTerminal`を受け入れる。
   - generation namespaceのdurable thread／turnだけを`thread/read`で照合する。
   - `terminal | pending | unknown`を返し、公開terminal receiptへraw thread／turn handleを出さない。
   - `turn/interrupt`、新thread、新turn、親watch遷移を呼ばない。
2. commit `02329ad`の`advanceGenerationHostProviderRollover`を受け入れる。
   - 一回のcallでmutating provider commandを最大一件だけ発行する。
   - `stop_authorized`再開はterminal観測だけを行い、stopを再送しない。
   - Codex terminal観測にはfull launch requestを渡し、private stop handleはcore用stopped receiptの
     局所再構成だけに使う。
   - provider spawn／readyが耐久回収できた後にだけcoreへspawn／readyを順に適用する。
   - 公開結果はprovider、target／watch、phase、bounded outcome／reasonだけを持つ。
3. Task Bの初回親レビューで、Task Aの結果shape不一致、spawn発行後の古い公開phase、
   terminal観測へprivate stop requestを渡すシグネチャ不一致を検出した。いずれもworker accept前に
   同じ2pathとfocused scopeで修正し、旧reportは採用しなかった。
4. 統合focused gateを受け入れる。

   ```text
   node --test \
     test/generation-host-lifecycle.test.mjs \
     test/claude-host-runtime.test.mjs \
     test/codex-host-runtime.test.mjs \
     test/generation-host-provider-binding.test.mjs \
     test/watch-store.test.mjs
   ```

   結果は46件成功、失敗・skip・cancel・todo各0、実行時間5248.0835msだった。
   `npm run check`と`git diff --check`も成功した。
5. live Claude／Codex、credential、network、UI、publish、pushは実行しておらず、H gateへ残す。

## Consequences

- recovery contextをClaude／Codex provider操作へ一stepずつ接続できる。
- command結果不明やcrash後にstop／spawn／readyを推測再送せず、pending／unknownでfail closedにできる。
- model request送信結果不明の別journal、parent rebind、planned rollover、fault recoveryは後続TODOとして残る。
- このADRを両Taskのfinalization Decisionと次のPhase integration証拠に使う。
