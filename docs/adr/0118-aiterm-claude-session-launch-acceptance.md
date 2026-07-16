# ADR 0118: Aiterm Claude session launchとinitial generationの受入

日付: 2026-07-16

## Status

Accepted。P5-1b4bを完了し、次のready TODOをP5-1b4cとする。

## Decision

- 新規production routeはprivate host handleを`claude.session`とし、Aiterm
  `aiterm.agent-launch-result.v1`のstructured `session_id`だけから作る。旧`claude.job`はblocked background
  characterizationの履歴互換として維持する。
- session名はtarget IDとwatch IDから決定的に作り、canonical Observer runtime rootをcwdとしてpromptなしの
  managed `claude_agent(agent_done:true)`を一度だけ呼ぶ。
- owner-only launch journalをtool call前に作る。transport結果が不明なら同じ`claude_agent`を再送せず、保存済み
  sessionへの`claude_turn(recover)`が`operation_not_found`を返した時だけsession生成済みとして回収する。
- Aitermの明示tool errorとrequest送信前の固定errorは`rejected`として保存し、unknownへ丸めずrecoverを禁止する。
  これにより、同名の既存sessionをresponse-loss recoveryで誤採用しない。
- structured spawned receiptの`claude.session`をwatchへ先に耐久化し、その後だけwatchをactiveへ進め、同じready
  receiptからClaude initial generationを作る。active後にcallerが再開した時はprivate watch bindingのprovider、target、
  watch、project、session handleを完全一致で照合し、同じgeneration初期化だけを冪等に再実行する。
- session生成receiptはClaude TUIやmodel responseのready証拠ではない。最初のmodel ready gateはP5-1b4cの
  `claude_turn issue`が担う。

## Evidence

- focused: 固定workspaceのnative implementer最終Runで27 passed・0 failed・0 skipped。
- related: parent launch、watch store、Aiterm Claude host runtime、generation storeで35 passed・0 failed・0 skipped。
- static: `npm run check` green。
- full regression: P5-1b4全体完了時へ集約し、このTODOでは未実施。
- 実Claude request、login、credential、publish、push、端末設定: 未実施。

## Parent refutation

1. launch response喪失後に同じsessionを再生成しないか。
   - `launching` journalがある再spawnを`E_AITERM_CLAUDE_LAUNCH_UNKNOWN`で拒否し、recoverは
     `claude_turn(recover)`だけを一度呼ぶfixtureで固定した。
2. Aitermが明示拒否した同名sessionをrecoverで誤採用しないか。
   - 初回focused後に明示tool errorまでunknownにしていた欠陥を発見した。固定errorを`rejected`へ分離し、
     recoverがtransportを呼ばない負系を追加した。
3. watch active後・generation初期化前のcrashで再開不能にならないか。
   - active watchではprivate bindingの完全一致を確認し、同じready receiptによるgeneration初期化を冪等に再開する。
4. 旧background routeやCodex handleを新routeへ読み替えていないか。
   - 旧`prepareParentLaunch`／`claude.job`を維持し、Aiterm専用builderだけを追加した。Codexは引き続き
     `codex.thread`だけを受理する。

独立重監査はP5-1b4全体完了時に一度行い、この子TODOでは親反証に限定した。

## Orchestration deviation

- 最初のnative Run中に親がread scopeの`src/`を修正したため、Controlが`WORKSPACE_DRIFT`で受入を拒否した。
  変更を戻したり古いreportを採用せず、固定後のretryへ切り替えた。
- 最初のretryでは親が`worker-report-import`より先に`observe-worker=completed`を記録したため、既知の
  `INVALID_TRANSITION`でimport不能になった。terminal Runを書き換えず、最後のretryを
  `dispatched → worker-report-import → accept`の正規順で回収した。
- この手順ミスによりfocused gateを余分に二回実行した。結果をfallbackや一回分へ偽装せず、最終受入値は
  固定workspaceの27/27と親related 35/35だけに限定する。

## Rollback

本commitをrevertし、Aiterm Claude launch journal、`claude.session` route、watch／generation接続、専用fixtureを
除去する。P5-1b4aのAiterm transport／Claude operation、旧background characterization、Codex callerは維持する。
