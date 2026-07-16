# ADR 0127: parent Stop hookをcallerと同じstate rootへ束縛する

日付: 2026-07-16

## Status

Accepted for implementation。queue 19eの新規model requestを止め、修理を
独立gate／独立commitで閉じてから
同じ承認済み通常campaignへ戻る。

## Context

P5-1b5bの実Claude attemptでAitermのpersistent parent sessionとmodel応答までは成立したが、
parent Stop hookは`observer parent claude run`へ渡したcampaign state rootと
異なる既定rootを参照した。
既定rootは未作成だったためhookは`E_PERMISSION_INVALID`となり、Throughline completed feedは0件のまま
terminalへ進めなかった。sessionは公開`pty_close`で閉じ、raw session ID、prompt、host log、設定本文は
Decision証拠へ保存していない。

## Decision

1. `observer-hook-config fragment|verify`は任意の`--state-root <absolute-path>`を受け、指定時は
   canonical commandへexactに含める。空白、quote、control character、relative pathはfail closedとする。
2. live preflightは`--state-root`を必須とし、Claude／Codex hook候補が同じrootをcommandへ持つことを
   public fragmentだけで検証する。
3. dotagents `apply-observer-hook-config`は通常apply／dry-runで
   `--state-root`を必須とし、両providerへ
   同じ値を渡す。異なる旧state rootを持つ同一Observer targetは保持せず、一件のcanonical entryへ置換する。
4. live runbookはpreflight、hook apply、Claude caller、Codex callerのstate rootを同一値へ固定する。
5. 修理前のlive attemptは成功証拠へ含めない。intentional fault、credential/login、push、publish、deployは
   引き続き実施しない。

## Acceptance

- Observer focused: hook fragment／CLI／live preflightがstate rootのcanonical性と
  invalid path拒否を固定する。
- dotagents focused: isolated HOMEで旧target置換、apply冪等、archive restoreを維持する。
- candidateを再pack／再installし、actual preflightが`h_required`、hook adapter再dry-runが両host差分0を返す。
- live再開後の成功／失敗は別の不変acceptance ADRへ記録する。
