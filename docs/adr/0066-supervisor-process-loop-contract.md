# ADR 0066: Supervisor外部processの所有権と終端を固定する

日付: 2026-07-16

## Status

Accepted for implementation。fake executable／fake child／fake one-step fixtureだけを本Taskで受け入れる。
実Codex model request、実Throughline長時間wait、Claude deliveryは後続のH gateに残す。

## Decision

1. `observer supervisor run`は既存のtarget／watchだけを受け取り、watch、generation、provider threadを新規作成・
   takeoverしない。target固有`supervisor-process.lock`をsession生成前からterminal cleanup後まで保持し、
   一target一外部processを保証する。一step内の`supervisor-step.lock`はcycle transaction境界として維持する。
2. processはabsolute Throughline／Codex executableとcanonical Observer runtime rootを検証する。Throughlineは
   公開`observer-read`／`observer-wait`だけをstrict clientから使い、Codex app-serverは一connectionを一度だけ
   initializeして全stepで再利用する。identity／version不一致をPATH fallbackや別binaryで隠さない。
3. active watchをprocess内で監視し、同じwatchの`stopping | stopped | faulted`または外部AbortSignalで
   Throughline waitを取消す。別watch、watch欠損、status read failureはfaultとしてfail loudにする。
4. one-stepの`timeout | committed`は同じprocessで次stepへ戻る。`model_pending | model_result_unknown`は
   bounded poll間隔を挟み、同じdurable operationだけをrecoverする。busy loop、新規model request、別thread探索を行わない。
   `rollover_required | provider_unavailable`はsanitized terminal resultとしてloopを止め、別責務のlifecycleへ返す。
5. signal cancelとexplicit watch stopはfaultへ偽装しない。step／monitorの未知failureはprocessを非0終了させ、
   watchを自動takeover・自動restart・成功へ遷移させない。
6. 全終端でCodex transportへSIGTERMを送り、grace内にcloseしなければSIGKILLする。close確認不能、transport cleanup、
   process lock解放の失敗は元のfailureと集約してfail loudにし、子process残存を正常終了へ丸めない。
7. CLI stdoutはterminal result一件、stderrはsanitized error一件だけとする。turn、cursor、model output、provider raw payload、
   launch handleを出力しない。SIGINT／SIGTERM cancel、explicit stop、faultを別status／exit codeで固定する。

## Acceptance

- process leaseの並走拒否、timeout再入、pending bounded poll、watch stop cancel、watch mismatch faultをfocused testで固定する。
- Throughline／Codex verification、initialize一回、session再利用、SIGTERM→SIGKILL terminal cleanupをfake processで固定する。
- CLI parse／sanitized result／exit mappingをfake runnerで固定する。
- TODO完了候補でSupervisor、Throughline client、Codex transport、CLIのrelated gateを一回、static gateを一回実行する。
- full regressionとlive host requestはPhase O2 gateまで実行しない。
