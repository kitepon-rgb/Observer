# ADR 0001: v1の親解決はThroughline completed cursorを正本にし、活動leaseを推測しない

日付: 2026-07-15

## Context

Observer v1は利用者からproject絶対pathだけを受け取り、Claude／Codexの親thread再作成へ追従する。
Throughlineはhost固有の完了証拠から`host`、`thread_sha256`、opaque cursor、switch／ambiguityを返す。

複数活動親を一般に識別するにはsession lifecycleの開始・終了とepochを持つleaseが必要だが、現host
hookには信頼できる親session終了eventがない。Throughlineのmonitor stateは短命hookのPIDを信頼せず、
15分の`updatedAt`を表示に使う契約であり、親leaseへ流用できない。mtime、DB更新時刻、monitor stale、
推測TTLからleaseを作ると、古い親をactiveと誤認する。

## Decision

1. v1は製品契約どおり、一projectにつき同時に活動する親は一つという前提を維持する。一般的な複数親
   arbitrationはv1へ追加しない。
2. 現在親identityは`target_id + host + thread_sha256 + completed cursor`で表す。raw session／thread ID、
   rollout／transcript pathをObserver stateや公開結果へ保存しない。
3. 初回orientationはThroughline `observer-read` snapshotだけを使う。`host=null`は完了turn待ちであり、
   推測でhostを選ばない。
4. `thread_switched`／`host_switched`は新親の最初の確定turnをThroughlineが返した時だけ採用する。
   mtime、DB件数、monitor stateで先行切替しない。
5. `ambiguous_parent`はfaultとしてfail closedにし、残レート、provider preference、最新mtimeで選ばない。
   `resync_required`も自動snapshotへ丸めず、明示reorientationを要求する。
6. `projection_pending`、pagination途中、read hard failureでは保存cursorと親identityを進めない。
7. host lifecycleが正式なstart／end／epochを提供できた将来版では、別ADRとmigrationでactive leaseを
   追加する。Throughline monitor stateや他製品のhookへ便乗しない。

## Consequences

- v1のproject-only UXと完了証拠境界を維持し、存在しないlifecycle証拠を実装済みに見せない。
- 同時に複数親を使うprojectはv1の前提外であり、Throughlineが検出できたambiguityは安全に停止するが、
  一般的な同時活動検出を保証しない。
- Observer resolverはThroughline JSON wireの厳格検証とcursor transactionへ集中できる。
