# ADR 0117: Aiterm transportとClaude provider operationの受入

日付: 2026-07-16

## Status

Accepted。P5-1b4aを完了し、次のready TODOをP5-1b4bとする。

## Decision

- Aiterm executableのowner／mode／inode／digestをspawn前、initialize後、各公開tool call前に再検証する。
- MCP 2025-11-25、server `aiterm` 0.13.0、`claude_agent`／`claude_turn`／`pty_close`の固定schemaだけを
  production依存として受け入れる。
- `claude_turn` structured resultだけをgeneric callbackへ変換し、人間向けcontent textを解析しない。
- issue前にcanonical cycle inputのdigest／byte数を再検証し、recoverではpromptを再送しない。
- provider journalはsession／operation／generation／receipt／output digestだけを持ち、prompt／raw outputを複製しない。
- 旧background用`claude-model-operation`はproduction consumerのないtest-only prototypeだったため、
  characterization harness本体を維持したままAiterm production operationへ置換する。

## Evidence

- focused: Aiterm transport＋Claude operation、8 passed・0 failed・0 skipped。
- related: transport、Claude／Codex provider operation、generic Supervisor cycle、model store、cycle input、
  Observer AI output、58 passed・0 failed・0 skipped。
- static: `npm run check` green。
- full regression: P5-1b4全体完了時へ集約し、このTODOでは未実施。
- 実Claude request、login、credential、publish、push、端末設定: 未実施。

## Parent refutation

1. completed後にAitermがpendingへ後退しても成功statusへ丸めないか。
   - 初回focused green後に欠落を発見し、completed→非completedと保存済みreceipt→operation_not_foundを
     `E_CLAUDE_RESULT_MISMATCH`へ変更。修正scope 8/8と最終related 58/58で固定した。
2. MCP transport再接続時に同じoperationを再送しないか。
   - generic dispatching／acceptedのrecoverは`claude_turn(recover)`だけを呼び、pending時もissueを呼ばない。
3. exact outputをprovider journalへ複製しないか。
   - raw outputはgeneric callbackへだけ返し、provider journalの本文不在を0600実fileで確認した。
4. Aiterm error本文やstderrをObserver結果へ漏らさないか。
   - tool error、protocol error、process exitを固定ObserverErrorへ縮約し、stderr本文を保存・返却しない。

独立重監査はP5-1b4全体完了時に一度行い、この子TODOでは親反証に限定した。

## Rollback

本commitをrevertし、Aiterm process transport、production Claude model operation、専用fixtureだけを除去する。
旧background characterization harness、Codex operation、generic Supervisor cycleは維持する。
