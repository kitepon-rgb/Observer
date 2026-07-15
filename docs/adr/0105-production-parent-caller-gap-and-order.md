# ADR 0105: production parent callerの欠落と実装順を固定する

日付: 2026-07-16

## Status

Accepted for implementation。ADR 0104のpreflight受入は維持するが、
「次はdual-host live H」というqueue裁定を訂正する。live操作はまだ実行しない。

## Context

preflight後の実source監査で、次の非H欠落が確認された。

1. `observer watch` handlerは`parentContext`と`hostActions`のDI境界を持つが、通常binaryは
   どちらも注入しないため、startは`E_PARENT_WATCH_CONTEXT_REQUIRED`で終了する。
2. `initializeGeneration()`は定義とtest fixtureだけで、production call siteがない。
   active watchだけを作ってもSupervisorはwatch／generation identity不一致で停止する。
3. `supervisor-production-step`はCodex runtimeだけをavailableとして受理する。
   Claude production operationのissue／recover／cleanupは未接続である。
4. dotagentsに現在親からObserver callerを起動するskill／agent／commandがない。

したがってfixture、preflight、runbookがgreenでも、dual-host campaignを開始できない。
H操作を行えばこの欠落が埋まるわけではなく、H-only TODOへの分類が誤りだった。

## Decision

1. P5-1bを次の順へ分割する。
   - Codex production parent caller core（非H）
   - Codex parent entryとdotagents配布（非H）
   - Claude公開非対話reply／result readのcharacterization（H）
   - 実証済み公開面だけを使うClaude production caller（非H）
   - dual-host live campaign（H）
2. Codex caller coreは現在親のexact contextを受け、providerをPATH、環境変数、rate、
   installed binaryから推測しない。開始前にObserver／Throughline／Codex runtimeをread-only検証し、
   Throughlineのcurrent parentがCodexかつ対象projectと一致することを確認する。
3. Codex callerは一つのprocess／一つのapp-server transportを所有し、次の順を固定する。
   - current parent確認
   - watch予約
   - app-server起動／initialize
   - thread spawn
   - spawned handle耐久化
   - ready観測／watch activation
   - 同じready receiptとcurrent parent digestによるinitial generation作成
   - 同じtransport／Throughline clientによるSupervisor loop
4. thread／turn結果不明、spawned handle耐久化前後のcrash、generation初期化失敗を
   別spawnや別transportへのretryで隠さない。回収できない時はunknown／stoppingを保持する。
5. stopは同じprocessとtransportで、同じthread／turnのterminalを確認してからwatchを閉じる。
   transportを先に閉じてterminal成功を捏造しない。daemon、自動起動、自動respawnは追加しない。
6. 親entryはCodex hostの明示指示からexact contextを作り、caller processのhandleを親が保持する。
   NodeからCodex native toolを偽装せず、Observer runtimeをdotagentsへ複製しない。
7. Claudeは公開非対話reply ACK、job／session／Stop相関、exact result readがliveで実在すると
   確認できるまでcallerを実装しない。private protocol、`claude -p --resume`、別providerへの
   fallbackで穴埋めしない。

## Acceptance

- Codex core focused fixtureで、verifier→parent確認→reserve→spawn→spawn receipt耐久化→
  ready→generation initialize→Supervisorの固定順と同一transport所有を確認する。
- parent不一致、runtime不一致、spawn／ready unknown、generation conflict、stop terminal unknownは
  fail loudとなり、別spawn／successへ丸めない。
- parent entry／dotagents配布はisolated HOMEでinstall／verify／rollbackし、live providerを起動しない。
- Claude characterization以降は別TODO・別H承認・別commitとする。
- related gateはcaller、watch、parent launch、generation、Supervisor process。full regressionと
  独立重監査はPhase O2完了時に一回だけ行う。
