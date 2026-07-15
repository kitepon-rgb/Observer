# ADR 0068: provider process faultでThroughline waitを即時取消する

日付: 2026-07-16

## Status

Accepted corrective decision。ADR 0066のfault停止を、provider transportと進行中waitの明示相関まで具体化する。

## Context

Codex app-serverが一時間Throughline wait中に終了しても、session requestが無い間は従来transport errorがprocess loopへ
伝わらない。変更到着後にcycleをprepareしてからprovider requestが失敗すると、provider不在を知りながらdurable cycleを
進める。timeoutまで待つことも「faultで停止する」契約に反する。

## Decision

1. Codex transportはprotocol failure、process error／exit、明示closeでabortするread-only termination signalを公開する。
2. 外部Supervisor processはprovider runtimeと同signalを一体所有し、signal abort時に進行中Throughline waitまたは
   model pending pollを取消す。外部signal cancelとは区別して`E_SUPERVISOR_PROVIDER_PROCESS_TERMINATED`で非0終了する。
3. fault後もtransportのSIGTERM→SIGKILL terminal cleanupとprocess lock解放を必須にする。watch／cycle／model journalを
   successへ補正せず、自動restartや別session fallbackを行わない。

## Verification

- fake transport exitでtermination signalがabortする。
- fake provider faultで進行中operationがcancelされ、runtime close 1回、process lock解放1回、error code exactを固定する。
