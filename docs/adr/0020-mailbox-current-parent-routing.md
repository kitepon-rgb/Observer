# ADR 0020: Mailbox routingはhash-only current parentへ線形化する

日付: 2026-07-15

## Status

Accepted for core implementation。Claude／Codexの実Stop hook wire、installer、advisory renderは未実装。

## Context

Mailbox schema v1はraw `thread_id`を保存していたが、Observerのcommitted parent stateはprivacy境界として
`thread_sha256`だけを持つ。raw IDをstateへ戻さずcurrent parentを照合し、旧thread messageを新threadへ誤配送せず
失効する境界が必要だった。またpublishがconsumer lockへ参加しなければ、親切替とstale走査の間に新messageが
割り込み、旧routeが新thread宛messageを失効し得る。

## Decision

1. 未公開message schema v1のtargetを`project_target_id + thread_sha256`へ変更する。message、claim、receiptへ
   raw thread IDを保存しない。
2. Stop payloadのraw thread IDはroute解決中だけ保持してSHA-256化する。canonical project target、active watch、
   watch provider、committed parent host／thread hashが全一致した時だけrouteを`current`とする。
3. target不明、watch inactive、parent pending、旧host／旧threadはclaimもstale処理も行わない。
4. current routeはMailbox lock取得前後に二度検証する。二度目も同じtarget／watch／thread hashの時だけ、
   旧thread messageを本文なし`stale_thread` receiptへ変え、current messageを高々一件claimする。
5. publishも同じtargetのconsumer lockへ参加し、duplicate ID scanからatomic createまでをclaim／stale処理と直列化する。
   lock競合は待機や暗黙retryをせず`E_CONSUMER_LOCKED`でfail closedにする。
6. 実host payload normalizationとcontinuation promptはP3-4のprovider adapterで追加し、このcoreへ推測実装しない。

## Verification

- mailbox store／consumer既存fault testsをhash schemaへ移行する。
- route resolverでunknown target、inactive watch、provider／thread不一致、current一致を固定する。
- current hookだけが旧messageをstale化し、routeがlock取得中に変わればinbox不変となるtestを追加する。
- focused Mailbox gateと`npm run check`だけを通し、full suiteはPhase gateまで回さない。

## Consequences

- raw host thread identityをObserver永続stateへ増やさず、Throughline由来のcurrent parent証拠とStop payloadを照合できる。
- 旧messageは別threadへ付け替えず、本文を削除したdigest-only receiptだけを残す。
- 実Stop hook wireが未実装なので、このcore単体を配送完成とは扱わない。

## Friction check

manual normalization、reconstructed evidence、alternate recoveryは使用していない。実host hook、model turn、Mailbox注入は実行していない。
