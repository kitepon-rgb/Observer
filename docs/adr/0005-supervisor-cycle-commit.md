# ADR 0005: 監査結果の耐久化後だけcursorをcommitする

日付: 2026-07-15

## Context

Throughline cycleは`proposed_state`を返すが、cursorを保存しない。Observerが監査またはMailbox publishより先に
cursorを保存すると、crash時に未処理turnを失う。逆に外部効果の直後、receipt保存前にcrashすると監査を
再実行しうるため、同じ助言の重複publishも防ぐ必要がある。

## Decision

1. targetごとに`cursor.json`（committed parent state）と`pending-cycle.json`（未完cycle journal）を分け、
   owner-onlyのObserver stateへ保存する。turn本文、prompt、raw session／thread IDはjournalへ保存しない。
2. cycle IDはtarget ID、base cursor、proposed cursorから決定的にSHA-256で導く。opaque cursor自体を
   filename、公開status、receiptへ出さず、cycle IDだけを外部効果のdedupe keyに使う。
3. orientation／changedの全page回収後、監査前に`pending-cycle.json`を`prepared`としてatomic createする。
   journalはwatch ID、base cursor、proposed parent state、cycle IDを持つ。
4. 監査、dedupe、必要なMailbox publishがすべてdurableになった後、Supervisor callbackは固定schemaの
   `result_digest`を返す。Supervisorはjournalを`processed`へatomic replaceしてdigestを保存する。
5. `processed` journalがdurableになった後だけ、保存中のbase cursorとのCASを確認し、`cursor.json`を
   proposed stateへatomic commitする。最後にpending journalを削除する。
6. crash recoveryは次の通りとする。
   - `prepared`で再開: committed cursorから同じfixed-through cycleを再構成し、cycle ID一致を確認して監査を再開する。
   - `processed`で再開: 監査を繰り返さず、base cursor CAS後にproposed stateをcommitする。
   - cursorが既にproposedでpendingが残る: cycle ID一致時だけpendingをcleanupする。
   - journal、cursor、watch IDが一致しない: faultとしてfail closedにし、自動reorientationやtakeoverを行わない。
7. `prepared`監査が外部効果を完了した直後、`processed`保存前にcrashする窓ではcallbackが再実行されうる。
   Mailbox message IDとdedupe receiptはcycle IDから決定的にし、同一助言の二重publishをatomic createで拒否する。
   v1で存在しない外部AI exactly-once ackを実装済みに見せない。
8. `projection_pending`はcursorとjournalを進めず、bounded retryする。上限超過、CLI hard failure、schema不正、
   cancel以外の異常はactive watchをfaultedにし、Stop continuationと自動再起動を止める。
9. `timeout`は正常結果であり、cursorとjournalを変更しない。次のcycleも同じcommitted cursorから待つ。
10. pending journalのtransaction lockも観測nonceによる明示回復だけを許し、PID、mtime、TTLで奪わない。

## Consequences

- 監査／Mailboxより先にcursorを消費する欠落を防げる。
- `processed`以降のcrashではAI監査を再実行せずcursor commitだけを再開できる。
- 外部AI呼出し自体のexactly-onceは保証せず、重複外部効果を決定的IDで抑止する。
- parent state store、pending journal、Supervisor retry／recoveryが次のF Taskになる。
