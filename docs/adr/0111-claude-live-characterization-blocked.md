# ADR 0111: Claude live characterizationをblockedとして固定する

日付: 2026-07-16

## Status

Accepted。P5-1b3bの一回限りのlive Hは実施済みとする。ただしP5-1b3全体は未完了、
P5-1b4 Claude production callerはblockedのまま維持する。

## Evidence

- 対象: Claude Code `2.1.210`、Observer `71267c7`
- preflight: `status=ready_for_h`、`reply_surface=unsupported`
- campaign: `sha256:4f676864646165c0c7f4bd8f15d8ef0766100f71da96ad71a75a87c3fdc9a174`
- 一つのClaude background jobと一つの固定model requestだけを起動した。
- jobは同じhandleで`done`まで公開observeでき、追加spawnは行っていない。
- isolated settingsのStop captureは生成されず、`error_code=E_STOP_CAPTURE_MISSING`となった。
- `job_session_correlation=blocked`、`stop_capture=blocked`、
  `terminal_exact_result=unsupported`である。
- characterization temporary rootのcleanup、Observer project fingerprint不変、
  Claude host settings不変はすべてconfirmedである。

raw job／session ID、prompt、settings本文、host log、account／credential fieldはreceiptへ
保存していない。raw `logs`、private job state、`claude -p --resume`、TUI自動操作へ
fallbackしていない。jobが自然にterminalへ到達したため明示stopは不要だった。

## Decision

P5-1b3bは「実施済みだが成立せず」とする。今回確定したのは、指定したisolated
characterization条件ではStop captureを得られず、公開非対話replyとterminal exact result readも
利用可能と実証できなかったことまでである。background agent一般でStop hookが動かない、または
特定のflagが原因だとは推測しない。

P5-1b4が必要とするdelivery、job/session/Stop相関、exact result recoveryの公開契約が揃わないため、
Claude production callerを部分実装しない。fixture成功、headless resume、private protocol、raw logで
不足契約を隠さない。同じClaude／Observer versionと同じ仮説のままlive jobを再実行せず、再開には
不足公開面またはisolated Stop capture条件を説明できる新しい非H証拠と、別のH承認を必要とする。

full regressionと独立重監査はPhase O2完了時まで実行しない。
