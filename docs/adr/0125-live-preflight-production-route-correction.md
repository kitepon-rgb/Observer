# ADR 0125: live preflightをproduction routeへ補正する

日付: 2026-07-16

## Status

Accepted for implementation。live provider、host config、model requestは実行しない。

## Context

P5-1b4でClaude production callerをAitermのpersistent PTYへ移した後も、live
preflightとrunbookはClaude 2.1.210のbackground job、Observer MCP probe、job handleを
検査していた。実機では、global Aitermが0.12.3のまま、Throughlineは0.6.3を返しても
`observer-read`を持たない旧packageだった。version文字列だけではlive prerequisiteを
証明できない。

また、dotagentsのhook config adapterはbackupを作るだけで公開restore入口を持たず、
元absent状態とmode／ownerを復元できなかった。実HOME apply前にdotagents `d304566`で
検証済み`--restore`を追加した。

## Decision

1. preflight引数をThroughline、Aiterm、Codexのabsolute commandへ固定する。
2. Throughline 0.6.3は同じcandidateで実`observer-read`を一回実行し、exact JSON wireを
   検証する。version一致だけを成功にしない。
3. Aiterm 0.14.0はstdio MCPを起動し、2025-11-25 initialize、server version、
   `claude_agent`、`claude_turn`、`pty_close`のexact schemaを確認して閉じる。Claude
   sessionとmodel requestは起動しない。
4. Codex app-server executable identity／version、Observer product、Stop hook候補、
   canonical cwdの既存検証を維持する。
5. live evidenceはpersistent Claude sessionの初回／follow-up exact result、session／
   generation相関、close terminalへ更新する。旧job evidenceへ戻さない。
6. live candidateは受入済み3 repo HEADをcampaign-local prefixへpack／installし、global
   packageを更新しない。hook rollbackはdotagentsの同じarchiveを`--restore`へ渡す。
7. timeout、crash、通信断などのintentional faultは通常campaignへ含めず、実行ごとに
   別の明示承認を要する。

## Acceptance

- focused: live preflightとCLIで固定順、sanitized blocked、Throughline surface欠落、
  Aiterm schema、required evidenceを固定する。
- related: Throughline client／runtime、Aiterm／Codex transport、product diagnosticsを
  一回通す。
- actual read-only: campaign-local 3製品candidateで`status=h_required`を得る。
- provider launch、model request、実HOME config read／write、hook trust、credential、
  intentional faultを実行していないことをreceiptへ残す。

## Rollback

本ADRと同じ実装commitをrevertし、dotagents `d304566`は独立した安全修理として維持する。
旧background job preflightへ戻してliveを続行せず、P5-1b5をblockedへ戻す。
