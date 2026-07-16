# ADR 0144: Observer Phase O2を受け入れる

日付: 2026-07-16

## Status

Accepted。この文書はP5-1b5／P5-1b5b／P5-3とPhase O2のimmutable acceptance matrixであり、
Control finalizationとdotagents cross-repo receiptのDecision証拠に使う。使用後は変更しない。

## Acceptance matrix

- queue 19e通常系dual-host live: ADR 0139。Claude r12／Codex r11の各2
  completed feed、同一generation 2 cycle、65秒超、pendingなし、terminal、
  設定exact rollbackを維持した。
- process-group訂正: `c936cfd`、`8056405`、`2b94392`、ADR 0140／0141。
  負PGIDのTERM→KILL、leader closeとgroup不在のAND、異常時
  `E_CODEX_PROCESS_TERMINATION_UNKNOWN`、実OS fixtureのgroup／子PID不在。
- pre-ready recovery訂正: `4bde91c`、ADR 0142／0143。Codex
  failed／interrupted／timeoutとClaude ready前失敗を同一watch
  identity／handleのterminal→faultへ閉じた。
- 修理後HEAD統合gate: `2b94392`。focused 16/16、related 68/68、
  full 412/412、fail 0、skip 0、fixture process残留0。
- 独立重監査: 初回P1一件を採用・修理。限定再確認でP0 0件、P1 0件、
  O2 closure可。

ADR 0139のcycle、65秒超wait、pending stateなし、caller cancel／provider terminal、設定rollback証拠は
維持する。leader terminalをprocess全体の終了へ読み替えた証拠だけはADR 0140で失効したままであり、
本Decisionは修理後source／testと実OS subprocess gateを新しい根拠にする。過去ADRは追記更新しない。

## Decision

1. Codex app-server cleanupは固有process group全体の消滅を確認する。PGID欠損、signal／probe異常、
   bounded上限超過をleader-only成功へ丸めず、終了不明としてfail loudにする。
2. post-spawn／pre-ready失敗はvalidated spawnで得た同一provider／watch／handleだけを停止し、provider
   terminal後にwatchを`faulted`へ閉じる。別watch、handle推測、暗黙restartへfallbackしない。
3. Observerは親と同providerの利用者可視な永続AI sessionであり、completed turnごとのfresh evaluatorを
   起動しない。Throughline L2はcompleted-turn証拠であってObserver cognitionの代替ではない。
4. SupervisorはAIではなくdelivery、exact-once、recovery、CAS、停止、Mailbox制御だけを所有する。
   Codex protocol、Observer cycle、provider cognitionの所有境界は変更しない。
5. 独立監査が採用したPGID欠損errorのP1はcommit `8056405`で修理した。full suiteで一度再現した
   subprocess fixtureのPID公開待ちraceは、group／子PID不在assertionを維持したまま5秒bounded待ちへ
   拡張し、最終full 412/412で閉じた。
6. 監査Executorは対象repo外のpath名を一件列挙するscope violationを自己申告した。内容は未読で、
   監査根拠・Decision・knowledge returnから除外した。対象repo内の実diffと限定再確認だけを採用する。

以上によりP5-1b5、P5-1b5b、P5-3とObserver Phase O2を完了とし、Controlをfinalizeする。
dotagentsがcross-repo receiptを受け入れた後だけ、親正本の次ready TODOであるO3へ進む。

## Knowledge return

- process-group cleanupの設計訂正: ADR 0140。
- process-group cleanupの実装受入れ: ADR 0141と本ADR。
- post-spawn／pre-ready recoveryの設計訂正: ADR 0142。
- post-spawn／pre-ready recoveryの実装受入れ: ADR 0143と本ADR。
- repo内部の契約欠陥であり、外部tool固有の再利用可能な罠ではないためcaveatへ重複登録しない。

## Excluded operations

intentional fault、追加の実model request、network、credential、login、push、publish、deployは実施していない。
fixtureをlive成功へ丸めず、ADR 0139の既存live証拠と今回の非H修理gateを分離して保持する。

## Rollback

`2b94392`、`8056405`、`4bde91c`、`c936cfd`を依存逆順にrevertし、本ADRの受入れを失効させ、
P5-1b5／P5-3とqueue 19eを再openする。ADR 0139の失効済みprocess残留0主張へ戻さない。
