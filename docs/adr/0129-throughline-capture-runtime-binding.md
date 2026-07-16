# ADR 0129: Claude captureとObserver readを同じThroughline candidateへ束縛する

日付: 2026-07-16

## Status

Accepted for campaign correction。新規Claude sessionより先にrunbookとcontroller環境を補正する。

## Context

state root修理後の実Claude attemptではObserver hook errorが消え、model応答とThroughline DB sessionは
成立した。しかしcompleted receipt fileは作られず、`observer-read`は0件だった。
Claude settingsのStop hookはbare `throughline process-turn`であり、Aiterm parent controllerのPATHが
global packageを先に解決した。一方、preflight／readはcampaign candidateをabsolute pathで検証していた。
同じversion文字列でもcapture surfaceが異なり、read側だけcandidateへ向けてもcompleted chainにはならない。

## Decision

1. Claude parentを保持するAiterm controller processは
   `PATH=<campaign-prefix>/bin:$PATH`で起動する。
2. host configへThroughlineの手製entryを追加せず、既存のproduct-owned bare hookをPATH解決で
   campaign candidateへ束縛する。
3. global Throughline packageを更新せず、candidateの`process-turn`と`observer-read`を同じprefixから使う。
4. 既存transcriptを手動でprocess-turnへ投入せず、失敗attemptを成功証拠へ含めない。
5. sessionは公開`pty_close`で閉じ、raw ID、prompt、host log、設定本文は保存しない。

## Acceptance

- runbookがAiterm controller PATHとcapture／read一致を明記する。
- 次のClaude attemptでcandidate receipt fileが自然Stop hookから作られ、`observer-read`が
  `host=claude`とcompleted turnを返す。
- 同じsessionのObserver initial／follow-up exact resultと65秒超waitが成立するまでlive成功にしない。
