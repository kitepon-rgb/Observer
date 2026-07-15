# ADR 0073: parent epoch rebind coreを受け入れる

日付: 2026-07-16

## Status

Accepted。設計commit `ed9867e`とhost-neutral core commit `426f8b9`を、
[ADR 0072](0072-parent-epoch-rebind-transaction.md)の第一waveとして受け入れる。
provider command、Supervisor caller、live hostは未完のまま後続waveへ残す。

## Accepted behavior

- generationはplanned rolloverと別の`parent_rebind` reasonを持ち、
  `active -> rebind_required -> stopping -> terminal_confirmed -> starting -> active`をexact検証する。
  `rebind_required`後は旧generationのmodel reservationを拒否する。
- Throughlineのready parent proposalから、同じtarget／watchのraw-free authorization receiptをrecord-firstで作る。
  journalはauthorization、old/new handle、terminal、launch、spawn、readyをdigestだけで保持する。
- old host terminal receiptとprivate handle digestを確認するまでnew epochを開始しない。
  new epochはsequence 1で始まり、同epoch内のplanned rollover APIでは回収できない。
- same-provider thread switchとcross-provider host switchを同じcoreで扱う。spawn receiptをjournalへ保存した後、
  watch providerとprivate handleを一回のCASで切り替え、ready後だけnew generationをactiveにする。
- authorization journal作成直後、start authorization後、spawn receipt後、ready receipt後の再入を
  同一identity／digestだけで回収する。異なるauthorization、receipt、provider、epoch、handleはfail loudにする。
- public status／resultとjournalへraw thread、cursor、launch handle、launch request本文を保存しない。
  old stop requestだけはprovider binding用のprivate runtime surfaceとしてhandleを返す。

## Verification

- focused: rebind core、generation store、watch storeの21 PASS / 0 FAIL / 0 SKIP。
- related: planned rollover lifecycle／provider binding、cycle store、Supervisor cycle／production／process、
  parent launchを含む83 PASS / 0 FAIL / 0 SKIP。
- static: `npm run check`、`git diff --check` PASS。
- full regressionはPhase O2 gateまで未実行。live provider、network、credential、publish、deploy、
  意図的障害試験は未実行。

## Remaining

- Claude／Codex provider commandをrebind coreへ一command一stepで接続する。
- Supervisor processでparent mismatchをdurable authorizationへ変換し、prepared cycleへ戻す。
- 実thread／host switchとcrash recoveryをPhase O2 H gateで受け入れる。
