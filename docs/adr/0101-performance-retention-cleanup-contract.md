# ADR 0101: performanceとretention cleanupを固定fixtureへ束縛する

日付: 2026-07-16

## Status

Accepted for implementation。live host latency、hook trust、実Throughline serviceの
性能受入は行わない。

## Context

P5-2aでclean install／verify／rollbackは閉じたが、P5-2には空Mailboxと通常waitの
latency実測、completed receipt cleanupが残る。既存coreはconsumerの`claimed`、
prepared publishが参照するreceipt、semantic historyのactive cooldownを保護する。
一方、性能分布と閾値を同じ環境で再現するfixtureがなく、receipt削除途中の失敗を
sanitizedなObserver errorとして受け入れる契約もない。

## Decision

1. `npm run test:performance`を標準full suiteと分離したfocused gateにする。
   macOS、Node `>=22.13`、warmup後の固定sample数をresultへ含める。
2. fixtureは次の三面を混同せず、`observer.performance_acceptance.v1`一件を返す。
   - 実`observer-parent-stop-hook` processのcontinued-turn起動を20回計測し、
     p95を250 ms以下、最大を750 ms以下とする。
   - authoritative routeを固定した実state directory／lock／readdirの空Mailbox coreを
     50回計測し、p95を50 ms以下、最大を250 ms以下とする。
   - 50 ms待機する隔離Throughline互換child processを10回起動し、待機時間を除く
     overheadのp95を250 ms以下、最大を750 ms以下とする。
3. percentileは昇順sampleのnearest-rankで計算し、負のoverheadは0へ丸める。
   resultはplatform、arch、Node、sample数、p50／p95／max、閾値だけを含み、
   HOME、temporary path、username、credential、raw payloadを含めない。
4. process fixtureはstdout／stderr／exit codeとexact wireも検証する。性能が閾値内でも
   wire不一致を成功にしない。非macOSと古いNodeはskipせずfail loudにする。
5. consumer receiptのdefault retentionは、30日超の完了receiptを削除し、最近の完了、
   `claimed`、prepared publish参照中を保持する。不正receiptを自動削除しない。
6. semantic historyのretentionは既存契約どおりactive cooldownを保持し、保護対象だけで
   飽和した場合は削除や成功へ丸めず`E_ADVISORY_HISTORY_SATURATED`で停止する。
7. completed receipt削除が途中で失敗した場合、固定
   `E_RECEIPT_CLEANUP_FAILED`を返す。すでに削除したexpired receiptは復元せず、
   protected／recent／inbox／processing／publish receiptを変更しない。
   同じ時刻とpolicyで再実行すると残りだけを削除し、同じ最終集合へ収束する。
8. このfixtureをlive host latencyや実Throughline service性能の成功証拠に使わない。
   それらはP3-4c／P5-1bのH gateへ残す。

## Acceptance

- focused: performance fixture、default retention、cleanup途中失敗と再実行収束。
- related: parent Stop hook、Throughline client、Mailbox consumer、semantic history。
- static: `npm run check`。
- full regressionと独立重監査はPhase O2 gateで一度だけ行う。
