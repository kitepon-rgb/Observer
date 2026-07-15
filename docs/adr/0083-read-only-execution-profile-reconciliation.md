# ADR 0083: read-only実行profileをSupervisor所有境界へ補正する

日付: 2026-07-16

## Status

Accepted for fixture implementation。P2-5に残るADR 0012以前の
「Observer AIへObserver MCP writeを許可する」完了条件を、
[ADR 0060](0060-supervisor-owned-cycle-runtime.md)後の単一所有へ補正する。
live Claude／Codex host、credential、hook trust、意図的write試験を受け入れたことにはしない。

## Context

ADR 0060はThroughline wait／read、evidence、provider result、Mailbox apply、cursor commitを外部Supervisorへ
一意化し、production Observer AIのtool surfaceを空にした。Observer MCPは`observer_read`／`observer_wait`だけの
read-only diagnostics／compatibility surfaceであり、Mailbox write APIを持たない。

一方P2-5には、Codex／Claudeの「Observer MCP限定write」をproduction受入条件とする旧TODOが残っていた。
この条件を実装すると、AIからThroughline／Mailboxを直接操作させてADR 0060の所有境界を再び二重化する。

Claude Code 2.1.210のローカル公開`--help`には、既存の`--setting-sources ""`、
`--disable-slash-commands`、`--no-chrome`、`--strict-mcp-config`に加えて`--safe-mode`と`--bare`がある。
ただし`--safe-mode`はcustom agentを無効化し、現在の公開background入口`--agent observer`との両立を
まだ実証していない。`--bare`はOAuth／keychainを読まず認証契約を変えるため、隔離fallbackとして採用しない。

## Decision

1. production AIにはproject file tool、Throughline、Observer MCP、Mailbox toolを一つも公開しない。
   Claudeはexact empty `--tools`／`--allowedTools`、Codexはruntime rootをcwdとするper-thread／per-turn
   `readOnly`・network offを維持する。
2. project観測は外部SupervisorがThroughlineとevidence collectorから行い、Observer state／Mailboxへのwriteは
   Supervisorの固定callbackだけが所有する。AIへ「限定write」を移さない。
3. 非H fixtureでは、両host envelope、Claudeの既存隔離flag、projectのHEAD／index／tracked・untracked／modeを
   含むfingerprint不変、Supervisor所有のMailbox publish成功を同じfixtureで確認する。
   これは実hostのwrite拒否やplugin／hook process隔離の証拠へ読み替えない。
4. Claudeの完全なsettings／hooks／plugins隔離は、`--safe-mode`と公開background agent定義、認証維持、
   隔離Stop hookが両立するかをlive H gateで確認してからproduction argvへ採用する。
   成立しなければ`--bare`、private protocol、別job、prompt規律へfallbackしない。
5. Codex UI／65秒超turn／adapter crash resume／interrupt、Claude reply ACK／
   re-stop／daemon・adapter crash resultは
   host別live H gateとして残す。Observer MCP writeは両hostのgateから削除する。

## Acceptance

- P2-5 TODOが「非H所有境界fixture → host別live H」の順に整理され、旧MCP write条件を完了扱いせず除去する。
- focused fixtureでhost envelopeとproject fingerprint不変を確認し、
  同じcycleのadvisoryがObserver state root配下の
  Mailboxへpublishされる。
- fingerprint取得失敗、provider tool追加、Mailbox receipt不一致を成功へ丸めない。
- live host、credential、hook trust、意図的project writeは未実行としてP2-5を未完のまま保持する。
