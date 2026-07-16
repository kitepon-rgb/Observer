# ADR 0137: Codex app-server childも親terminal signalから隔離する

日付: 2026-07-16

## Status

Accepted。実装gateとqueue 19e実Codex正常停止はgreen。

## Context

queue 19eのClaude正常停止では、foreground Observerと同じprocess groupのAiterm MCP childがSIGINTを
先に受け、session close前にtransportが終了した。ADR 0135のdetached child修理で、ObserverのAbortSignal、
session close、transport terminalの順を実証した。

Codex app-server transportも同じspawn条件を持つ。正常SIGINTではObserverがactive turnをinterruptして
terminalを観測してからtransportを閉じる必要があり、childへterminal signalが直接届く構造は同じ順序を
破る。

## Decision

1. Codex app-server childをdetached process groupでspawnする。
2. `unref`は行わず、stdio所有と`closeAndWait`のSIGTERM→SIGKILL→terminal確認を維持する。
3. 親signalはObserverのAbortSignalだけへ渡し、Codex stop／terminal回収を先に完遂する。
4. app-server自身の予期しない終了は従来どおりprovider faultとし、cancelledへ丸めない。
5. Codex protocol、thread／turn identity、interrupt receipt、output parserは変更しない。

## Acceptance

- spawn optionの独立process groupをfocused transport testで固定する。
- Codex runtime／parent caller／Supervisorの関連gateを一度通す。
- 修理済みcandidateの実SIGINTでcaller terminalとapp-server terminalを確認する。
- raw thread／turn ID、prompt、model output、credentialは証拠へ保存しない。

## Gate evidence

- focused Codex transport＋runtime: 13 passed、0 failed、0 skipped。
- related transport＋runtime＋caller＋Supervisor＋CLI: 69 passed、0 failed、0 skipped。
- queue 19e candidate r11のSIGINTでcaller `cancelled`／exit 130、managed
  app-server terminal、local app-server残留0、親app-server公開close `closed`を確認した。
