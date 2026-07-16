# ADR 0131: campaign Aiterm runtimeへUnix socket長境界を設ける

日付: 2026-07-16

## Status

Accepted for campaign correction。次のClaude launchより先に短いruntimeへ切り替える。

## Context

ADR 0130の専用`TMPDIR`をcampaign root配下の`aiterm-runtime`として作成したところ、Aitermが使う
最終tmux socket pathは105 bytesになった。macOS SDKの`sockaddr_un.sun_path`は104 bytesであり、
終端NULを含めるとpathnameは103 bytes以下でなければならない。Aitermはsession生成前にtmux errorを返し、
model requestもcompleted receiptも発生しなかった。

## Decision

1. campaign root直下の短い`r`を本人所有0700の専用`TMPDIR`にする。
2. `<TMPDIR>/claude-tmux-sockets/claude-mcp`のbyte長をlaunch前に計測し、macOSでは103以下を必須とする。
3. 長いruntimeへ失敗したattemptを成功へ含めず、空の生成物だけを確認して削除する。
4. global socket、session、package、設定を変更せず、短いruntimeでfresh serverを作る。

## Acceptance

- runtime directoryは本人所有0700、最終socket pathは92 bytesである。
- Aiterm public `claude_agent`がsessionを作り、candidate自然Stopからcompleted receiptが作られる。
- raw ID、prompt、PTY log、設定本文はDecision証拠へ保存しない。
