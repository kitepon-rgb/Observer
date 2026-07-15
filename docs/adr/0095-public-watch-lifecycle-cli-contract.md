# ADR 0095: 公開watch lifecycle CLIを親注入host actionへ束縛する

日付: 2026-07-16

## Status

Accepted for implementation。両providerの実host action、live spawn／stop、
session相関はP5-1bのH gateへ残す。

## Context

Observerは一target一watchのstate transaction、親authorization、Claude／Codex別host runtime、外部Supervisorを
既に持つ。一方、公開`observer` CLIはtarget登録とCodex Supervisor processしか提供せず、製品契約の
`observer watch <absolute-project-root>`、共通status、明示stopへ接続されていない。

CLI processがproviderを環境変数や残rateから推測したり、host actionを実行したふりにすると、現在親による明示起動、
同provider、private handle、実host H gateを破る。逆にprovider handleを公開statusや一般CLI resultへ含めると、
owner-only state境界を失う。

## Decision

1. 公開文法を次へ固定する。`watch start`は明示形、`watch <path>`は製品契約どおりのaliasとする。

   ```text
   observer watch <absolute-project-root> [--state-root <absolute-path>]
   observer watch start <absolute-project-root> [--state-root <absolute-path>]
   observer watch status <absolute-project-root> [--state-root <absolute-path>]
   observer watch stop <absolute-project-root> [--state-root <absolute-path>]
   ```

2. 利用者が指定する必須入力はproject pathだけとする。start／stopを実行する現在親は、argvやambient envではなく、
   exact `observer.parent_watch_context.v1`として`parent_provider`、
   canonical Observer `runtime_root`、対応intentの
   authorizationをcommand handlerへ注入する。context欠損、provider不一致、相対runtimeはstate変更前に拒否する。
3. host actionはprovider別adapterとしてhandlerへ注入する。startは`spawn` receiptを親transactionへ耐久化してから
   `ready`を観測し、stopはprivate parent stop requestをadapter内だけへ渡す。adapterはhandleを公開resultへ返さない。
   adapter不在または未実証は、target登録／watch予約／stopping遷移より前に`provider_unavailable`を返す。
4. startは`prepareParentLaunch → host spawn → confirmParentHostSpawn →
   host ready → confirmParentLaunch`の順だけを許す。
   spawnまたはreadyが未確定なら再実行や別handleへのfallbackをせず、それぞれ`starting`／`launching`を公開する。
   一targetのlive watch、後勝ちtakeover、terminal watch IDを観測しない再startは既存CASのerrorをそのまま表面化する。
5. statusはregistered targetの`readWatchStatus`だけを読み、`observer.watch_command_result.v1`の`watch`へsanitized
   `observer.watch_status.v1`を投影する。launch handle、host receipt、
   provider output、raw errorを含めない。
6. stopは明示stop authorizationとcurrent provider一致をstate変更前に検証し、
   `requestParentStop`後にhost adapterへprivate stop requestを渡す。
   terminal receiptが未確定なら`stopping`を保持し、同じhandleのexact terminal receiptを
   `completeParentStop`が受理した場合だけ`stopped`へ閉じる。
7. fake host actionでClaude／Codexが同じCLI result schemaと状態遷移を持つことをfocused testで固定する。
   fake成功をproduction実証へ数えず、通常binaryへ実host adapterを注入するwaveとlive確認はP5-1bへ残す。

## Consequences

- 公開CLIのUXとprovider固有host wireを分離し、status／resultからprivate handleを漏らさず共通化できる。
- 親contextや実証済みadapterが無い通常start／stopは成功しない。
  これは未統合を隠さない意図的なfail loudである。
- installer／dotagents adapterは、本契約のcontextとhost actionを現在親から注入する責務を持つ。
