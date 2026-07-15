# ADR 0012: Claude host adapterを純粋なargv／receipt境界にする

日付: 2026-07-15

## Status

Accepted for core implementation。production launch、Observer MCP server、parent-launch wire、crash recoveryは未採用のまま残す。

## Context

ADR 0010／0011で、Claude backgroundは同じAgent一覧へjob IDを公開できる一方、次を実測した。

- 可変長の`--tools`／`--mcp-config`より後ろにpromptを置くと引数として取り込まれる。
- `--tools`は公開面、`--allowedTools`は`dontAsk`下の無人許可であり、両方のexact指定が必要である。
- terminal jobへの再stopは成功receiptを返さないことがある。
- `claude logs`のraw出力はObserverに不要なアカウント／利用状況表示を含み得る。

host actionを直接state transactionへ埋め込むと、shell escaping、raw出力漏洩、stop結果とterminal観測の混同が起きる。

## Decision

1. `claude-host-adapter` coreは外部processを起動しない純粋層とし、`execFile`互換の`command`と`args[]`だけを生成する。
   shell文字列やpromptの別fieldは生成しない。commandは実行層が解決した正規化済み絶対pathを要求し、
   realpath／version／所有確認は実行層gateで行う。
2. background argvは固定長flag、固定prompt positional、可変長flagの順にする。`--agent observer`、`dontAsk`、
   空setting sources、skills／Chrome無効、strictな単一Observer MCPを必須にする。
3. 組込みtoolは`Read,Grep,Glob`だけとし、Observer MCP toolは`mcp__observer__*`だけを受理する。
   MCP toolを`--tools`と`--allowedTools`の両方へexact指定する。MCP commandはcanonical `runtime_root`配下の
   正規化済み絶対path、argsは`--stdio`だけに字句的に束縛する。symlink実体の所有確認は実行層gateで別途行う。
4. `agents --json`はjob ID、name、canonical cwd、`kind=background`で相関する。返すobservationは
   `job_id`、`name`、`cwd`、`state`、`observed_at`だけとし、`sessionId`、raw JSON、未知fieldを捨てる。
5. 既知stateは`working`、`blocked`、`done`、`stopped`、`failed`の固定集合とする。
   前二者だけstop commandを生成し、後三者は`already_terminal`としてstopを再発行しない。未知stateは拒否する。
   同jobのstop command receiptが既にあれば、outcomeにかかわらず`await_terminal_observation`を返して自動再発行しない。
6. stop commandのexit 0とexact stdout `stopped <job-id>`だけを`command_confirmed`とする。
   その他は`command_unknown`とし、raw stdout／stderrをreceiptへ含めない。terminal完了は後続の同job観測で別に確定する。

## Consequences

- argv順序、権限面、相関、出力衛生をprovider process抜きのfocused testで固定できる。
- `command_confirmed`だけでwatchを`stopped`へ進めることはできない。parent-launch統合時もterminal observationが必要である。
- 公開一覧で既存characterization jobの`done`、`stopped`、`failed`を再観測済み。stop後の再発行抑止は純粋fixtureで固定する。
- daemon／adapter crash後のresult receiptとObserver MCP限定writeは別gateのまま残る。
