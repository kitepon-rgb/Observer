# ADR 0045: O1両host live wait fixtureを受け入れる

日付: 2026-07-15

## Status

Accepted

## Context

Throughlineのcompleted-turn feedをObserverの公開subprocess境界から利用し、Claude receiptとCodex
`task_complete`の両方で、既定の短いtest timeoutを超えるlive waitが成立することを固定する必要がある。
Observer commit `dc31c08`は、別projectのClaude/Codex waitを並行起動し、一度の65.1秒待機後に
各host固有の正式完了証拠を投入するblack-box fixtureを追加した。

旧Control `observer-o1-live-fixture-20260715` revision 8の親受入は成果とfocused testを正しく記録したが、
revision 9のTask finalizationは可変な`docs/plan_observer.md`をDecision証拠として受理した。この旧receiptは
監査履歴として保持するが、本ADRの受入根拠には使わない。

## Decision

1. Observer commit `dc31c08`の`test/throughline-black-box.integration.mjs`を、O1の両host live wait
   fixtureとして受け入れる。
2. fixtureはObserverから実`throughline observer-wait` CLIだけを呼び、DBやrolloutの直接読取へ
   fallbackしない。
3. Claudeは実`process-turn`入口が発行するcompleted receipt、Codexはrolloutの`task_complete`を使う。
4. 両waitの実argvに`--timeout-seconds 3600`が含まれ、共有した65.1秒待機後に両方が
   `changed`で完了することを必須とする。
5. focused gate
   `OBSERVER_THROUGHLINE_BIN=/Users/kite/Developer/Throughline/bin/throughline.mjs node --test test/throughline-black-box.integration.mjs`
   は2件成功、失敗・skip・cancel・todo各0、実行時間68,441.638msだった。同一workspace digestの
   greenを反復しない。

## Consequences

- Throughline側O1計画の「Claude／CodexそれぞれのObserver fixtureで65秒超live wait」を完了できる。
- Throughlineの関連回帰、文書同期、Phase full gate、独立監査は別TODOとして残る。
- Observerのprovider binding作業（ADR 0044）はO1完了後に再開し、この受入waveへ混ぜない。
