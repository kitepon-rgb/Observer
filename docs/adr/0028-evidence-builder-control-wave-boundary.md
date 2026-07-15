# ADR 0028: evidence builderをsuccessor Controlへ移送する

日付: 2026-07-15

## Status

Accepted。この文書はControl finalizationのimmutable証拠として使用するため、使用後は追記・修正しない。

## Context

`observer-codex-host-runtime-20260715`はbounded budget `max_worker_runs=4`を使い切った。
P4-2 snapshot builderのRun 1はfocused testがgreenでも公開schema、strict再検証、bounding、可読性を
満たさず、親がControl revision 47でrejectした。Run 2は正規retryとしてdispatchしたが、native executorが
ファイルを変更せず応答もしなかった。親がinterruptとControl cancel requestの順を誤り、その事実を
revision 52のDecisionへ明記し、revision 53のterminal receiptでcancelledへ閉じた。順序の再発防止は
dotagents commit `f4f453f`へ還流済みである。

成果物は未受入であり、Task自体は未完成である。worker上限を越えて同じControlへ5件目を追加したり、
reject済みRunを再dispatchしたり、未受入ファイルを成功証拠にしたりしない。

## Decision

1. `observer-evidence-snapshot-builder`は成果取消ではなくsuccessor移送のため現Controlでcancelする。
2. 現Controlをfinalize/archiveし、同じ`docs/plan_observer.md`をobjectiveとするsequence 2 successorを作る。
3. successorでは新しいTask／assignment／Run IDと新しいPacket／Report相関を使う。
4. 未受入の2ファイルはsuccessor writerが同じwrite scope内で全面置換する。
5. P4-2、Observer全体、live H gateの完了は宣言しない。

## Friction check

native無応答とinterrupt順序誤りをalternate recoveryとして認識し、dotagentsの正本TODOとCodex
orchestrate appendixへ還流した。手補正でWorker Reportを作らず、Run 2を成功へ丸めていない。

## Consequences

- 旧Controlの失敗履歴とbudget消費を保持したまま、未完Taskを新しいbounded waveで再開できる。
- 可変planをDecision／finalization digestに使わず、本ADRをimmutable証拠にできる。
