# ADR 0092: host-neutral core E2Eとlive host境界を分離する

日付: 2026-07-16

## Status

Accepted for implementation。P5-1の非H core統合を先に固定し、Claude／Codexの実provider request、
hook trust、credential、実host faultは後続H gateへ残す。

## Context

Throughline completed feed、Supervisor process、Codex provider journal、semantic decision、Mailbox、
parent Stop coreは個別のfocused／related gateを通過している。一方、同じowner-only stateで
`completed turn -> cycle -> decision -> Mailbox -> parent Stop`を貫通する製品E2Eはまだない。

Claude production deliveryはADR 0060／0064により、公開非対話request ACKとsession相関をlive Hで
実証するまで`provider_unavailable`へ固定している。fake callbackでClaude成功を作ると、このblockerを
隠して両host対応済みに見せる。

## Decision

1. `test/observer-core-e2e.test.mjs`は、temporaryなowner-only stateとprojectを使い、target、watch、
   generation、cycle、model operation、semantic decision、Mailbox、parent Stopの実moduleを接続する。
   内部state storeやapplication callbackを成功stubへ置き換えない。
2. 外部境界だけをversioned fixtureにする。Throughlineは公開`observer-wait`／`observer-read`と同じschema、
   Codexはapp-serverの`thread/read`／`turn/start`と同じrequest／resultを返す。Throughline DB／WAL、
   Codex private state、TUI automationを読まない。
3. Codex advisoryは同じoperationを`accepted -> completed -> applied -> committed`へ進め、semantic decisionが
   acceptedの時だけ一件をMailboxへpublishする。親Stop coreはcurrent provider／threadへ一度だけ描画し、
   二回目は本文を再配送しない。
4. `no_advisory`とsemantic suppressionはcursorをcommitするがMailboxを作らない。cooldown中の同一指摘、
   severity escalation、suppressed replayは既存semantic decisionを再利用し、別decisionへすり替えない。
5. provider accepted後、decision record後、Mailbox publish後、parent claim後の再入を、同じidentityの
   再実行で収束させる。duplicate message、旧thread／別provider、emit失敗はそれぞれexact replay、
   non-claim／stale、`delivery_unknown`となり、成功や再配送へ丸めない。
6. Claude fixtureはactive Claude watch／generationとruntime欠損を作り、Throughline wait、pending cycle、
   model journal、semantic decision、Mailboxの変更前に`provider_unavailable`を返すことだけを受け入れる。
   Claude成功callback、別job spawn、Codexへのfallbackを追加しない。
7. 実Throughline CLIのcompleted-only／65秒超waitは既存black-box greenを再利用する。本Taskでは外部process、
   model request、hook設定、credential、意図的host fault、full regressionを実行しない。

## Acceptance

- focused: 新規E2EでCodex advisory／silence／suppression、exact replay、誤配送、claim failure、
  Claude fail-loudを固定する。
- related: Supervisor production／cycle、semantic decision、Mailbox、parent Stopの関連testをTODO完了候補で
  一度だけ実行する。
- stateと公開resultへturn本文、raw provider handle、prompt、raw evidence、message本文を新たに複製しない。
- 両host live成功とP5-1親TODOは閉じず、P5-1b H gateへ残す。

## Rejected

- Claude成功をin-memory callbackで作る: live blockerを隠す。
- Throughline DB fixtureを直接生成する: 製品所有境界を破る。
- 個別unit testの単なる一括実行をE2Eと呼ぶ: transaction間の接続を証明しない。
