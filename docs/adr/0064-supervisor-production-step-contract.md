# ADR 0064: Supervisor production callerを一target一stepへ固定する

日付: 2026-07-15

## Status

Accepted for implementation。production caller coreとfake public-surface fixtureを本Taskで受け入れる。
CLI process lifecycle、実Codex app-server、Claude deliveryは後続／H gateに残す。

## Decision

1. `runSupervisorProductionStep`一callは一targetの一cycle stepだけを実行する。target固有`supervisor-step.lock`を
   Throughline wait開始前からprovider／apply／cursor commit終了まで保持し、同targetの並走を拒否する。
2. lockは時刻やPIDから自動回収しない。inspectとexpected nonce付きrecoverだけを公開し、owner process終了の確認は
   運用層が所有する。
3. lock内でactive watch、private host binding、active generationを再読し、target／watch／providerを完全一致させる。
   Codexは`codex.thread` handle、pre-initialized app-server session、canonical Observer runtime rootを要求する。
4. pending cycleのbase cursorとproposed cursorからdomain-separated digestを作り、Throughline turns、approved plan refs、
   test receiptsをevidence collectorへ渡す。proposed parentはreadyで、generationのparent epoch、provider、targetへ一致する
   場合だけcanonical cycle inputを生成する。host／thread switchは旧generationへ送らずrebind requiredで止める。
5. Codex issue／recover／cleanupはprovider固有journal APIだけへroutingする。issueは同threadの一回の`turn/start`、
   recoverはexact turnの`thread/read`、cleanupはgeneric completed一致を使う。session errorを別requestへfallbackしない。
6. apply／finalizeは[ADR 0062](0062-cycle-application-callback-contract.md)のproduction callbackへ、同stepで再構成した
   canonical cycle inputを渡す。raw outputやmessage本文をcaller returnへ含めない。
7. Claudeは公開非対話deliveryとsession相関がlive H gateで成立するまで、wait／pending cycle／model journalを
   変更する前に`provider_unavailable`を返す。Codex runtime欠損も同様とする。

## Acceptance

- callback routing、cycle input identity、parent epoch mismatch、Claude／Codex unavailable、lock解放をfocused fixtureで固定する。
- real private lockで並走拒否、inspect、wrong nonce拒否、明示recoverを固定する。
- Supervisor、evidence、Codex provider、cycle applicationのrelated gateをTODO完了候補で一度だけ実行する。
- full regressionとlive host requestは実行しない。
