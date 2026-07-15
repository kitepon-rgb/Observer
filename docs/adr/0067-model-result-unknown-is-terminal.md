# ADR 0067: model result unknownをpollせずterminal faultにする

日付: 2026-07-16

## Status

Accepted corrective decision。ADR 0066 Decision 4のうち、`model_result_unknown`をbounded poll対象とした部分を
本ADRでsupersedeする。`model_pending`のpoll契約は維持する。

## Context

Codex provider operationの`model_result_unknown`は、`turn/start`後かつprovider journal保存前のcrashによる
handle欠損、または保存済みturnの`failed | interrupted`を表す。前者はexact turn locatorがなく、後者はterminalである。
同じstepを再実行しても新しい証拠は増えず、別turn探索やrequest再送はADR 0055／0060のexact回収契約に反する。

## Decision

1. `model_pending`だけをbounded pollし、同じdurable operationの`thread/read`回収へ戻す。
2. `model_result_unknown`は`E_SUPERVISOR_MODEL_RESULT_UNKNOWN`としてprocessを非0終了し、transport terminal cleanupと
   process lock解放を完了する。別request、別thread探索、自動restart、watch成功遷移を行わない。
3. provider journalやgeneric operationを削除・補正せず、同一handleのexact回収不能を運用層へ明示する。

## Verification

- focused fixtureでpoll回数0、runtime close 1回、process lock解放1回、error code exactを固定する。
- TODO関連gateはADR 0066の受入時に一回だけ集約する。
