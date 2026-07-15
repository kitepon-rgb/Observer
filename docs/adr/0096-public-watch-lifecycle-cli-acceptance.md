# ADR 0096: 公開watch lifecycle CLIの非H handlerを受け入れる

日付: 2026-07-16

## Status

Accepted。通常binaryへの実host action注入、live spawn／stop、session相関、P2-4／P5-1全体は未完のまま維持する。

## Accepted scope

- `observer watch <absolute-project-root>`と`watch start|status|stop`の文法を公開CLIへ追加した。
  利用者argvへprovider、runtime、handleを要求せず、現在親のexact contextをhandler引数へ分離した。
- startはadapter利用可能性をstate変更前に確認し、既存parent transactionの
  `prepare → spawned耐久化 → ready → active`だけを使う。live watchの二重startを拒否し、terminal watchは
  観測済み`expected_previous_watch_id`のCASでだけ再startする。
- statusと全command resultは`observer.watch_command_result.v1`へ統一し、
  private handle、host receipt、
  raw provider出力を含めない。ID、timestamp、fault code、action別status、未知fieldをstrict検証する。
- stopはadapter欠損でactive stateを変更せず`provider_unavailable`を返す。
  adapter利用時もterminal receiptが
  未確定なら`stopping`を保持し、同じprovider handleのexact receipt後だけ`stopped`へ閉じる。
- Claude／Codex fake host actionは同じresult schemaと遷移を通る。fake成功をproduction実証へ数えない。
  親contextを注入しない通常binary startは`E_PARENT_WATCH_CONTEXT_REQUIRED`でfail loudになる。

## Evidence

- design: `d1ababe`、implementation: `a4195a3`。
- focused: `node --test test/watch-lifecycle.test.mjs test/cli.test.mjs` —
  13 PASS / 0 FAIL / 0 SKIP。
- related: lifecycle、CLI、project target、watch store、parent launch —
  37 PASS / 0 FAIL / 0 SKIP。
- static: `npm run check`、`git diff --check`、ADR単体markdownlint — green。

## Remaining

- dotagents／installerが現在親のprovider、runtime、authorization、実host actionをhandlerへ注入する。
- Claude／Codexのlive spawn／stop、session相関、UI表示、hook trustはP5-1bのH campaignで受け入れる。
- P2-4親TODO、P5-1親TODO、Phase O2監査、full regressionは閉じない。
