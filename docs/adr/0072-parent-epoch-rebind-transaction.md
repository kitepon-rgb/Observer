# ADR 0072: parent epoch rebindを独立transactionへ固定する

日付: 2026-07-16

## Status

Accepted for implementation。host-neutral rebind transaction、provider binding、Supervisor統合を
独立commit／gateに分ける。planned rollover journalへparent rebindを混ぜず、watch／provider faultも
後続の別transitionに残す。実Claude／Codex commandとhost switchはPhase O2のH gateまで完了扱いにしない。

## Context

Supervisor production stepはThroughlineが確定したparent proposalとcurrent generationの
`parent_epoch_id`が違う時、旧generationへのmodel requestより前に
`E_SUPERVISOR_PARENT_REBIND_REQUIRED`で停止する。しかしこの結果をdurable receiptへ記録せず、
generation stateは旧epochから切り替えられない。planned rolloverは同じparent epoch／provider内の
物理generation交代だけを扱うため、そのjournalへrebindを丸めるとreason、provider、generation IDの
意味が壊れる。

一方、watchは最初のユーザー明示指示ですでに継続監視を認可されている。parent rebind時の
「parent authorization」は新しいユーザー承認を要求する意味ではなく、Throughlineのhost-bound completed
turnから得たcurrent-parent proposalを、同じtarget／watchの次epochとしてrecord-firstで固定する意味とする。

## Decision

1. parent rebindは`observer.generation_parent_rebind.v1`の専用journalを持つ。planned rollover journal、
   model operation journal、watch fault receiptへfallbackしない。
2. Supervisorがmodel request前に受け取った`ready` parent proposalから、target、project、watch、cycle、
   provider、thread digest、cursorをexact検証する。current epochと異なる時だけ
   `observer.parent_rebind_authorization.v1` receiptを作る。journalにはreceiptのcanonical digest、
   `from/to parent_epoch_id`、`from/to provider`だけを保存し、raw thread、cursor、launch handle、
   proposal本文を保存しない。
3. generationは次の独立transitionを持つ。
   `active -> rebind_required -> stopping -> terminal_confirmed -> starting -> active`。
   `rebind_required`作成後は旧generationへのreservation／model requestを拒否する。
4. host-neutral coreは一call一durable transitionとし、次をrecord-firstで進める。
   - rebind authorizationを記録してgenerationを`rebind_required`へ進める。
   - old host stopを認可してからgenerationを`stopping`へ進める。
   - 同じprivate old handleのterminal receipt確認後だけ`terminal_confirmed`へ進める。
   - canonical next launch requestのdigestを記録してからnew epoch generationを`starting`で作る。
   - spawn receiptをjournalへ保存してからwatch host bindingをold provider／handleから
     new provider／handleへ一回のCASで切り替える。
   - ready receiptとnew watch bindingを照合してgenerationを`active`へ進め、journalを削除する。
5. new parent epochの最初のgeneration sequenceは1とする。同epoch内のplanned rolloverだけがsequenceを
   増やす。generation IDは従来どおりwatch ID、new parent epoch ID、sequenceから決定する。
6. providerが変わらないthread switchとClaude↔Codexのhost switchを同じhost-neutral schemaで扱う。
   watch ID、target、project、created_atは維持し、watch providerとprivate handleはnew host spawn receipt後の
   CASで同時に切り替える。旧terminal不明時はnew hostを起動しない。
7. crash recoveryはjournal statusとcurrent generation／watch bindingをexact照合し、同じauthorization、
   terminal、launch、spawn、ready receiptだけを冪等に受け入れる。異なるreceipt／provider／epoch／handleは
   conflict、provider command結果不明は`unknown`としてfail loudにする。
8. provider bindingは既存planned rolloverと同じく一call一provider mutationに制限するが、rebind専用coreを
   呼ぶ。Supervisor processはproduction resultの内部`rebind_required`を受けて同じprocess lease内で回収し、
   new epoch activation後に保存済みprepared cycleへ戻る。公開CLI terminal resultへ
   `rebind_required`やauthorization本文を出さない。
9. parent proposalがwaiting／ambiguous／resync、同じepoch、別target／watch／project、または未prepared cycleなら
   authorizationを作らない。新watch、自動takeover、別handle探索、別providerへの暗黙fallbackを行わない。

## Implementation waves

1. host-neutral core: generationのrebind transition、専用journal、watch provider＋handle CAS、fake receipt fixture。
2. provider binding: Claude／Codexのstop、terminal、spawn、readyを一command一stepへ接続する。
3. Supervisor integration: mismatchをdurable`rebind_required`へ変換し、process restartとprepared cycle再開を接続する。
4. Phase O2 H gate: 実Claude／Codex thread switch、host switch、terminal不明、crash recoveryを検証する。

## Acceptance

- authorization receipt作成後は旧generationのmodel callbackが一度も呼ばれない。
- old host terminal receipt前にnew epoch generation／provider hostを開始できない。
- same-provider thread switchとcross-provider host switchの両fixtureで、同じwatch IDのままnew epoch sequence 1が
  activeになり、watch provider／handleがnew hostと一致する。
- crash境界ごとに同じreceiptは冪等、異なるreceipt／identityはfail loudになる。
- durable stateと公開resultにraw thread、cursor、launch handle、request本文、provider outputを含めない。
- TODOごとにfocused test、完了候補で関連gateを一度、full regressionとlive providerはPhase O2末に一度だけ行う。
