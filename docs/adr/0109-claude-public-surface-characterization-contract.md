# ADR 0109: Claude公開面characterization契約を固定する

日付: 2026-07-16

## Status

Accepted for implementation。P5-1b3の非H準備とlive H trancheを分離する。
本ADRはClaude model request、background launch、host config適用、hook trust、credential、
login、intentional faultを許可しない。

## Context

[ADR 0108](0108-codex-parent-entry-and-distribution-acceptance.md)でCodex parent entryまで
完了したため、次はClaude production callerの前提となる公開面characterizationである。
しかし既存のdual-host runbookとpreflightは、親Mailbox配送用
`observer-parent-stop-hook`の候補を検証するだけで、provider result capture用の
project-local Stop hookを生成・実行しない。

Claude Code 2.1.210の公開CLIをread-onlyで再確認したところ、`claude agents --help`は
一覧表示用`--json`／`--all`とagent view設定を公開するが、既存background jobへ
非対話でrequestを送る`send`／`reply` subcommandを公開していない。`claude -p --resume`、
private protocol、TUI自動操作をproduction surfaceへ読み替えてはならない。

2026-07-15の実測はheadless result、resume、background lifecycleの基礎characterizationであり、
次をまだ証明していない。

- launch後の同じbackground jobへ一request一ACKでdeliveryできる公開非対話面
- `agents --all --json`のjob `sessionId`とStop payload `session_id`の一致
- Observer所有の隔離`--settings` result-capture hookによる`last_assistant_message`取得
- terminal後もprivate stateやraw logへfallbackせずexact resultを再読できる公開面

## Decision

1. P5-1b3を次の順へ分割する。
   - **P5-1b3a（非H）:** characterization専用の隔離Stop capture、sanitized receipt、
     prepare／verify／cleanup harnessを実装し、fixtureで閉じる。
   - **P5-1b3b（H）:** Claude Codeの固定versionで一つのbackground jobだけを起動し、
     公開面の成立／不成立を一回characterizeする。
   - **P5-1b4（非H）:** P5-1b3bで実証された公開面だけでproduction callerを実装する。
2. characterization hookはprovider result capture専用とし、親Mailbox配送用
   `observer-parent-stop-hook`を流用しない。continuation、Mailbox claim、外部LLM、network、
   long-pollを行わず、matching `Stop`一件を短時間でstrict parseする。
3. 非H harnessはClaudeを起動せず、次だけを行う。
   - 固定schemaの一時設定候補とhook commandを生成する。
   - user／project／local settingsを読まず、候補をisolated `--settings`へ渡せる形で検証する。
   - fixtureのjob/session/Stop相関、exact result、重複、別session、欠損、cleanupを固定する。
4. H trancheは[専用runbook](../claude-public-surface-characterization-runbook.md)の一回だけとする。
   既存jobへの公開非対話request surfaceが存在しなければ`unsupported`を正しい結論として記録し、
   別入口へfallbackしない。session相関、Stop capture、terminal exact resultのいずれかが
   不成立なら`blocked`とする。
5. raw job ID、raw session ID、prompt、host config本文、raw host log、credentialは
   ADR、Control、receipt、commitへ保存しない。hookとagent-list parserはraw IDをprocess内だけで
   SHA-256化し、固定schemaのdigestと既知fixture resultだけを出力する。
6. daemon／adapter crash、通信断、timeout注入などのintentional faultはP5-1b3bへ含めない。
   必要なら目的、影響、rollbackを説明した別H trancheにする。

## Acceptance

- focused fixtureでsettings isolation、Stop payload strict parse、session digest一致、
  exact result digest、重複／別session／欠損拒否、private temporary state cleanupを固定する。
- preflightはClaude binary／version／公開help surfaceとcharacterization候補をread-onlyで検証し、
  `ready_for_h`または具体的blockerを返す。live成功へ丸めない。
- H receiptは`reply_surface`、`job_session_correlation`、`stop_capture`、
  `terminal_exact_result`、`cleanup`をそれぞれ`confirmed | unsupported | blocked`で記録する。
- production caller、dual-host campaign、full regression、独立重監査は本TODOで実行しない。

## Rejected alternatives

- 親Mailbox hookをresult captureとして扱う: payloadを配送identityにしか使わず、
  `last_assistant_message`を保存しないため棄却する。
- `claude -p --resume`をbackground replyへ読み替える: host lifecycleとACK contractが異なる。
- `claude logs`またはClaude private job stateをterminal resultの標準fallbackにする:
  daemon消失後の公開回収性と出力衛生を証明できない。
- interactive agent viewの自動操作をproduction protocolにする: 非対話公開契約ではない。
