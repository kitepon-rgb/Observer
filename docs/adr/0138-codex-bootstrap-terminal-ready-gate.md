# ADR 0138: Codex bootstrap completed後だけObserverをreadyにする

日付: 2026-07-16

## Status

Accepted。

## Context

実Codex parentのseed `task_complete`はThroughlineへ一件確定した。続くObserver callerは専用Codex
threadとbootstrap turnを開始したが、そのturnが`inProgress`のままwatch／generationをactiveへ進めた。
Supervisorの最初のcycleは同じthreadにactive turnを検出し、`E_CODEX_CYCLE_TURN_ACTIVE`で停止した。

`turn/start` ACKはdurable turn handleと実行開始の証拠であり、Observer AIがbootstrap契約を適用して次の
cycleを受けられる証拠ではない。永続thread上のbootstrap turnはterminalになってもthread文脈を維持する。

## Decision

1. initial／generation activationは、保存済みbootstrap thread／turnを`thread/read`でpollする。
2. 同じturnの`completed`だけをreadyへ昇格し、その後にready receipt／watch activationを行う。
3. `inProgress`はbounded pollを継続する。`failed | interrupted`と上限到達はfail loudにする。
4. 別turn開始、別thread spawn、terminal historyの別identity利用へfallbackしない。
5. ready recoveryは同じdurable bootstrap turnの`completed`を受け入れる。identity不一致は拒否する。
6. Codex model cycle、strict output parser、parent feed、Supervisorの非AI責務は変更しない。

## Acceptance

- activation testで`inProgress → completed`の後だけready／watch activationとなる順序を固定する。
- bootstrap failed／interrupted／timeoutと別turn identityをfail closedにする。
- initial／generation ready recoveryが同じcompleted turnだけを回収することを固定する。
- caller／Supervisor関連gateを一度通す。
- 修理済みcandidateの実Codexで初回cycle commitを確認する。
- raw thread／turn ID、prompt、model output、credentialは証拠へ保存しない。

実装gate（2026-07-16）:

- focused `test/codex-host-runtime.test.mjs`: 17/17 PASS。
- related Codex caller／transport／model operation／generation binding／Supervisor:
  111/111 PASS。
- `npm run check`、本ADRのmarkdownlint、`git diff --check`: PASS。

Live acceptance（2026-07-16）:

- queue 19e candidate r11でbootstrap completed後に初回cycleをcommitした。
- 親feed 2件、同じgenerationのcompleted cycle 2件、初回cycle後65秒超を確認した。
- pending reservation／cycle／model operation残留なし、caller cancelと両app-server
  terminalを確認した。
