# ADR 0021: 親Stop hook coreをhost wireとMailbox transactionへ限定する

## Status

Accepted for core implementation。installer、実host設定、live同一turn検証はP3-4b／P3-4cに残す。

## Context

Mailboxはcurrent project／provider／threadへhash-onlyで束縛され、atomic claim後の再配送を禁止している。
残る親adapterは、Claude／CodexのStop payloadを同じ認可coreへ渡し、有効な手紙がある時だけ同じ親turnを継続させる。

OpenAIのCodex 0.144.3 Hook契約は`session_id`をcurrent Codex session、`turn_id`をactive turnとして渡し、
`decision:"block" + reason`を同一turnのcontinuation promptにする。ThroughlineのCodex feedは同じraw session／thread IDを
SHA-256化する。ClaudeのStop契約もcurrent `session_id`を渡し、正常なguidanceには
`hookSpecificOutput.additionalContext`を使える。

HookにはHost ackがない。stdoutの書込、Observer receiptの更新、Hostによる採用を一つのatomic transactionにはできない。
またStop continuation後は`stop_hook_active=true`で再びStopが発火するため、queueを同じturnで連続drainすると
Claudeの8回上限や不要なagent loopを招く。

## Decision

1. provider別payload parserは`hook_event_name=Stop`、absolute `cwd`、bounded raw `session_id`、boolean
   `stop_hook_active`を必須にする。Codexはbounded `turn_id`、Claudeは存在する場合だけbounded `prompt_id`を相関へ使う。
2. raw IDは`claimCurrentParentMessage`へ渡した後は永続化せず、receiptの`hook_event_id`はprovider、session、turn／prompt、
   active flagから作るSHA-256 digestにする。
3. `stop_hook_active=true`はclaim前にfast exitする。一つの親turnへObserver由来のcontinuationを最大一件にする。
4. advisoryは固定順、制御文字正規化、16 KiB以下とする。Claudeは`additionalContext`、Codexはblock reasonへ入れる。
5. stdoutのwrite callback成功後に`finishClaim(..., emitted_unacked)`を行う。Host採用ackとは扱わない。
6. claim後に失敗した場合は`recoverClaimAsDeliveryUnknown`で本文を削除する。回収失敗は握り潰さず非0にする。
7. Mailboxなし、route不一致、continued turnはstdoutを空のままexit 0にする。network、LLM、project scan、long-pollを呼ばない。

## Consequences

- Observerの判断・state・配送transactionはObserverプロジェクトに残り、親projectには薄いhook配線だけを置ける。
- Host ack不在のためexactly-once deliveryは主張できないが、本文のat-most-once注入と不明状態の明示は維持できる。
- 実際に同じ親turnへ表示されること、設定合成、rollbackはこのcore testだけでは証明せず、後続gateで扱う。
