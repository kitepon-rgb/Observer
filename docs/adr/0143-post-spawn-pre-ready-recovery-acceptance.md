# ADR 0143: post-spawn／pre-ready recoveryを受け入れる

日付: 2026-07-16

## Status

Accepted。P5-1b5b-r16のsource／test修理を受け入れる。P5-1b5とPhase O2全体は、修理後HEADの
full regression、独立重監査、knowledge return、Control finalization、cross-repo receiptが未完了のため閉じない。

## Context

ADR 0142は、validated spawn後のready失敗でprovider transport／sessionだけを閉じ、watchを`launching`へ
残していた欠陥を採用した。実装前のfocused fixtureは12/18 pass、6 failで、Codex bootstrap
failed／interrupted／timeout、Claude ready前失敗、cleanup失敗の証拠保持を再現した。

## Decision

commit `4bde91c717f07b6a5c7562194dfeb286fec0ed61`をP5-1b5b-r16のsource／test修理として受け入れる。

1. 両provider callerはvalidated spawned receiptをready確定まで保持し、pre-ready失敗時だけ同じ
   launch request／watch identity／handleで`requestParentLaunchFailureCleanup`を呼ぶ。
2. Codexは既存の同一thread／turn stop loopを共用する。failed／interruptedはterminal receiptを受け取り、
   timeoutは同じturnのinterrupt後にbounded pollし、terminal後だけwatchを`faulted`へ閉じる。
3. Claudeは通常session shutdownの装着をready確定後へ移した。pre-ready失敗では同じsessionを
   `stopAitermClaudeObserver`で閉じ、terminal receipt後だけwatchを`faulted`へ閉じる。
4. provider terminal receiptはprovider／watch／target／handleをstop requestと再照合する。不一致を
   watch fault成功へ丸めない。
5. cleanup不能は元のready失敗とcleanup失敗を`AggregateError`で保持する。turn/start結果不明など
   terminalを確定できないcaseも、別turn／別watch／別provider／暗黙restartへfallbackしない。
6. provider terminalとwatch terminalの後にだけraw transportを閉じる。pre-spawnとpost-ready経路、
   Codex protocol、Observer cycle、Supervisorの非AI責務は変更しない。

## Acceptance evidence

- focused: Codex／Claude parent caller tests — 19/19 pass、fail 0、skip 0。
- related: parent-launch、watch-store、Codex／Claude Supervisor tests —
  33/33 pass、fail 0、skip 0。
- static: `npm run check` — syntaxと`git diff --check`がgreen。
- Codex failed／interruptedは一回、timeoutはinterrupt receiptを引き継ぐ二回の同一stop operationで
  terminalへ進み、その後だけwatch fault、transport closeとなった。
- Claudeは同じsession terminal、watch fault、MCP closeの順となり、通常shutdownをready前に装着しない。
- handle不一致とcleanup不能はwatch faultを呼ばずfail loudとなった。
- intentional live fault、model request、network、credentialは使っていない。

## Recovery boundary

cleanup後のwatchはterminal `faulted`であり、同じtargetの次回予約は観測済みprevious watch IDを明示した
既存CASだけを使う。自動restartや別identityの採用は行わない。terminalを証明できないcaseは成功扱いせず、
`stopping`または失敗状態を保持して明示回復へ委ねる。

## Rollback

commit `4bde91c`をrevertし、本ADRの受入れを失効させ、P5-1b5b-r16を未完了へ戻す。provider closeだけで
watch recoveryを完了扱いにせず、`launching`残留を明示欠陥として再openする。
