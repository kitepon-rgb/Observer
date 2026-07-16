# ADR 0132: queue 19eのsocket実測とStop flush修理を訂正証拠にする

日付: 2026-07-16

## Status

Accepted。ADR 0131の予測socket名／byte数と、receiptをsocket境界単独のAcceptanceにした部分を
このDecisionで訂正する。

## Context

短いcampaign専用runtimeで実際にAitermが作るsocketは
`<TMPDIR>/claude-tmux-sockets/claude.sock`であり、`r2`使用時の実測は94 bytesだった。
これはmacOSのpathname上限103 bytes以下で、Aiterm sessionと実Claude turnは起動した。

同じattemptではClaudeが`end_turn`となりStop hook 4本もerror 0だったが、ThroughlineのDB本文と
completed receiptは0件だった。turn後の同一transcriptはlatest logical groupを1件返したため、原因は
async Stopがfinal assistant行のtranscript可視化より先にone-shot backfillしたflush raceである。

## Decision

1. ADR 0131の`claude-mcp`／92 bytesを実物`claude.sock`／94 bytesへ訂正する。旧ADRは不変証拠として残す。
2. socket境界のAcceptanceは短いruntimeでのsession生成、candidate-first PATH、実Claude turn成立までとする。
3. completed receiptは別のThroughline Stop flush barrierを通過して初めて受け入れる。
4. Throughline commit `a46b915`のbarrierは`last_assistant_message`を本文にせず、latest user groupの
   assistant completion identityにだけ使う。deadline不一致は明示失敗し、旧groupへfallbackしない。
5. このattemptはdual-host live成功へ含めず、修理済みcandidateを再梱包して同じ通常campaignを再開する。

## Acceptance

- Throughline focused 14/14、process-turn subprocess 2/2、related 78/78が成功した。
- 修理はThroughline commit `a46b915`、受入れ記録は`af06e0a`で独立確定した。
- 次のClaude attemptでcandidate receiptと`observer-read` completed turnを自然Stopから確認する。
- raw session ID、prompt、PTY本文、設定本文はDecision証拠へ保存しない。
