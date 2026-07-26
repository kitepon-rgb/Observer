# ADR 0151: terminal watchから新watchへgeneration正本を切り替える

日付: 2026-07-26

## Status

Accepted for execution。

## Context

Observer 0.1.2でCodex bootstrapは完了したが、新watchをactiveへ進めた後の
`initializeGeneration`がtarget単位の旧generation stateを一律拒否し、
`E_GENERATION_ALREADY_EXISTS`で監視再開できなかった。watch storeはterminal watchから
観測済みprevious watch IDを使った新watch予約を許可する一方、generation storeにwatch切替契約がなかった。

## Decision

1. `initializeGeneration`は同じwatchの競合generationを従来どおり拒否する。
2. 既存generationが別watchの場合、新watchが同じtarget／providerでactiveであることをtransaction内で照合する。
3. 旧generationのstatusが`active | terminal_confirmed | faulted`で、pending reservationがない場合だけ、
   新watch sequence 1のfresh stateへatomic置換する。
4. pending reservation、rollover／rebind／fault途中状態は
   `E_GENERATION_PREVIOUS_WATCH_UNRESOLVED`で停止し、旧stateを変更しない。
5. 0.1.3を公開・global installし、installed production watchの`active`継続を受入条件とする。

## Acceptance

- 新watchは旧generation ID／budget／handle digestを継承せずfresh sequence 1になる。
- pending reservationを持つ旧watchは置換されず、元stateが保存される。
- focused／full／package gateがgreenである。
- installed 0.1.3のbingo watchが`active`を維持する。

## Rollback

- npm公開前は変更commitをrevertする。
- 公開後は0.1.3をunpublishせず、必要ならdeprecatedにして0.1.2へglobal installを戻す。
