# ADR 0130: live campaignのAiterm runtimeをglobal tmux serverから隔離する

日付: 2026-07-16

## Status

Accepted for campaign correction。新規Claude sessionより先に専用runtime directoryを作る。

## Context

ADR 0129どおりcontroller processのPATH先頭をcampaign prefixへ変更しても、completed receiptは0件だった。
Aitermは`TMPDIR`配下の固定tmux socketを再利用し、常駐server作成時の環境を新sessionへ継承する。
既存global serverが古いPATHを持つため、caller processのPATH変更だけではbare Throughline hookの解決先を
candidateへ切り替えられない。

## Decision

1. campaign root配下に本人所有0700の専用runtime directoryを作る。
2. Claude parent controllerへ専用`TMPDIR`とcandidate-first `PATH`を同時に渡し、
   fresh Aiterm tmux serverを作る。
3. global Aiterm socket、session、package、Throughline packageを変更しない。
4. 失敗attemptを成功へ含めず、公開close terminal後にだけ隔離runtimeで再launchする。
5. raw ID、prompt、PTY log、設定本文をDecision証拠へ保存しない。campaign cleanup時に専用runtimeを削除する。

## Acceptance

- 専用runtimeのmode／ownerをlaunch前に確認する。
- candidate自然Stopからreceipt fileが作られ、`observer-read`がClaude completed turnを返す。
- initial／follow-up、65秒超wait、terminal、rollbackはqueue 19e全体の受入へ残す。
