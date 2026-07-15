# ADR 0114: Claude live再characterizationをblockedとして固定する

日付: 2026-07-16

## Status

Accepted。P5-1b3dの一回限りのlive H再characterizationは実施済みとする。ただし
P5-1b3全体は未完了、P5-1b4 Claude production callerはblockedのまま維持する。

## Evidence

- 対象: Claude Code `2.1.210`、Observer `c7b2b27`
- preflight: `status=ready_for_h`、`reply_surface=unsupported`
- campaign: `sha256:4ea60cace09fbc3a0f53f86b343658de5aeadac6f61acb6fa7ee3214562ba588`
- 一つのClaude background jobと一つの固定Haiku model requestだけを起動した。
- jobは公開observeで`done`へ到達し、明示stopと追加spawnは行っていない。
- `hook_invocation=confirmed`、`job_session_correlation=confirmed`、
  `stop_capture=confirmed`である。
- canonical Observer resultは`E_CLAUDE_CHARACTERIZATION_RESULT_INVALID`で拒否され、
  `result_capture=blocked`である。
- `reply_surface=unsupported`、`terminal_exact_result=unsupported`である。
- characterization temporary rootのcleanup、Observer project fingerprint不変、
  Claude host settings不変はすべてconfirmedである。

raw job／session ID、model output、prompt、settings本文、host log、account／credential fieldはreceiptへ
保存していない。raw `logs`、private job state、`claude -p --resume`、TUI自動操作へfallbackしていない。

## Decision

P5-1b3dは「再characterizationを実施し、失敗箇所を確定した」として完了する。最初のliveで不明だった
Stop hookは実際に発火し、Stop payload、cwd、job／session相関まで成立した。今回のblocked原因は、
Stop payloadの`last_assistant_message`がcanonical Observer AI output契約を満たさなかったことである。
raw outputを収集していないため、余分な文言などの具体的な不一致内容は推測しない。

同時に、既存background jobへの公開非対話replyとterminal exact result readはClaude Code 2.1.210の
公開面に存在しない。P5-1b4が必要とするdeterministic deliveryとexact result recoveryが揃わないため、
Claude production callerを部分実装しない。fixture、別processのheadless request／resume、private protocol、
raw logを成功代替にしない。

再開には、Claudeの固定versionまたは公開契約が変わり、同一background jobへの非対話requestとexact
result recoveryを公開面だけで構成できる新しい非H証拠が必要である。新しいlive実証を要する場合は、
目的・影響・rollbackを示した別H承認を得る。full regressionと独立重監査はPhase O2完了時まで
実行しない。
