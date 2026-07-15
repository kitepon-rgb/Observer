# ADR 0102: performanceとretention cleanupを受け入れる

日付: 2026-07-16

## Status

Accepted。P5-2を完了とする。live host HとPhase O2全体は完了扱いにしない。

## Evidence

- design `1d045df`: [ADR 0101](0101-performance-retention-cleanup-contract.md)
- implementation `8b49493`: performance fixture、default retention、
  sanitized cleanup failure、retry convergence
- focused consumer gate: 10/10
- related gate: Mailbox consumer、parent Stop hook、Throughline client、
  semantic historyの39/39
- static gate: `npm run check` green

`npm run test:performance`はmacOS arm64、Node 26.5.0で次を返した。

| 面 | p50 | p95 | max | p95閾値 | max閾値 |
| --- | ---: | ---: | ---: | ---: | ---: |
| hook process | 31.177 ms | 32.165 ms | 32.502 ms | 250 ms | 750 ms |
| empty Mailbox core | 21.025 ms | 23.936 ms | 29.134 ms | 50 ms | 250 ms |
| bounded wait overhead | 34.396 ms | 35.982 ms | 35.982 ms | 250 ms | 750 ms |

bounded waitは隔離childの50 ms待機を除いたoverheadである。resultはplatform、arch、
Node、分布、閾値だけを含み、HOME、temporary path、username、credentialを含まない。

default 30日retentionはold completedだけを削除し、recent completed、`claimed`、
prepared publish参照中を保持した。semantic historyはactive cooldownを保持し、
保護対象だけでの飽和を`E_ADVISORY_HISTORY_SATURATED`で拒否した。
削除途中の失敗は`E_RECEIPT_CLEANUP_FAILED`となり、再実行は残りだけを削除して
同じ最終集合へ収束した。

## Decision

P5-2を受け入れる。P3-4bのinstaller／verify／rollback親TODOも、既存hook adapterと
P5-2aの製品package gateが揃ったため完了へ整合させる。live host latency、実Throughline
service性能、actual hook apply／trustは未検証であり、P3-4c／P5-1bのH gateへ残す。
full regressionと独立重監査はPhase O2 gateで一度だけ行う。
