# ADR 0135: Aiterm MCP childを親terminal signalから隔離してsessionを先に閉じる

日付: 2026-07-16

## Status

Accepted。実装gateはgreen。queue 19eの実正常停止再検証を受入れへ残す。

## Context

queue 19eの実Claudeでmanaged Observer初回cycleはcommitしたが、foreground callerへSIGINTを送ると
`E_AITERM_TRANSPORT_CLOSED`で非0終了し、managed Claude sessionが一件残った。別processから公開
`pty_close`を呼ぶと`closed`で回収できたため、session側のterminalではない。

ObserverはSIGINTをAbortSignalへ変換し、Supervisorの`finally`でClaude sessionを`pty_close`してから
Aiterm MCP transportを閉じる契約を既に持つ。一方、Aiterm MCP childはforeground Observerと同じprocess
groupでspawnされるため、terminal SIGINTを直接受けてこの順序より先に終了できる。

## Decision

1. Aiterm MCP childをdetached process groupでspawnし、親terminalのSIGINT／SIGTERMを直接継承させない。
2. `unref`は行わない。stdio所有と`closeAndWait`のSIGTERM→SIGKILL→terminal確認を維持する。
3. 親signalは従来どおりObserverのAbortSignalだけへ変換する。signal handlerからtransportを直接閉じない。
4. 正常cancelはmanaged Claude sessionのexact `pty_close`を先、Aiterm MCP transport terminalを後にする。
5. provider process自身の予期しない終了は従来どおりprovider faultであり、正常cancelへ丸めない。

## Acceptance

- spawn optionが独立process groupを要求することをfocused testで固定する。
- session shutdown時の`pty_close`→MCP close順序と両failure保持の既存gateを通す。
- 修理済みcandidateの実SIGINTでcaller `cancelled`、session terminal、残留session 0を確認する。
- raw session ID、prompt、PTY本文、credentialは証拠へ保存しない。

## Gate evidence

- focused Aiterm transport＋Claude runtime: 9 passed、0 failed、0 skipped。
- related transport＋caller＋Supervisor＋CLI: 43 passed、0 failed、0 skipped。
- 実SIGINT再検証はqueue 19e live Hで行い、fixture greenへ代入しない。
