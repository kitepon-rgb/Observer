# ADR 0078: generation faultをrecord-first terminal-confirmed transactionにする

日付: 2026-07-16

## Status

Accepted for implementation。watch／provider faultの耐久化、host terminal確認、Supervisor recovery抑止を
一つの独立transactionとして実装する。実host停止、意図的provider障害、credentialを要する検証はPhase O2のH gateへ残す。

## Context

watch storeはhost child終了後の`faulted`を表せるが、generation storeにはplanned rollover／parent rebind用の
`stopping -> terminal_confirmed`しかない。Supervisorのprovider process終了やmodel result unknownは現在、進行中waitを
取消して非0終了するだけである。この時点でwatchを直接`faulted`へ閉じると、host childのterminalが不明なままhandleを
失い、孤児回収不能になる。反対に状態を残すだけでは、新しいSupervisor processがplanned rollover／parent rebindを
自動再開し、fault後の無断restartや別handle探索へ進み得る。

faultは通常停止、planned rollover、parent rebindから独立したreason／transitionで表し、既に発行済みのhost stopを
再送せず、同一handleのterminal receiptだけで閉じる必要がある。

## Decision

1. target private stateへ`generation-fault.json`を追加する。固定schemaはtarget、watch、provider、generation、parent epoch、
   fault code、fault検知時のgeneration status、停止対象handle、journal status、terminal receipt digest、時刻だけを持つ。
   raw provider error、stderr、prompt、thread／job本文、model出力を保存しない。
2. fault codeは公開済みの固定集合へ写像する。provider transport終了、model result unknown、その他Supervisor hard failureを
   区別し、任意文字列やraw errorをwatch state／journalへ通さない。
3. `recordGenerationFault`はjournalをatomic createしてからgenerationを専用fault lifecycleへ進める。generationは
   `fault_required -> fault_stopping -> fault_terminal_confirmed -> faulted`を持ち、元のbudget、pending reservation、
   rollover reasonを証拠として保持する。通常cycle／rollover／rebind入口はfault lifecycleをactiveとして扱わない。
4. fault検知時点でgenerationが`stopping | terminal_confirmed`なら、既存stopは発行済みとみなしjournalを
   `stop_authorized`から開始する。`active | rollover_requested | rebind_required | starting`なら`fault_recorded`から開始し、
   `prepareGenerationFaultStop`の初回だけ`issue_once`を返す。二回目以降は`observe_only`とし、stopを再送しない。
5. fault journalはplanned rollover／parent rebind journalと同居できるが、以後の回復順はfaultを最優先にする。
   既存journalを削除・成功補正せず、fault source evidenceとして凍結する。fault pending中は新generation start、provider
   runtime再生成、別handle／別thread探索、takeoverを行わない。
6. terminal receiptはprovider、target、watch、保存済みhandle、`stopped` outcomeをexact検証する。command ACK、timeout、
   signal abort、provider process exit、handle不明はterminal receiptとして扱わない。
7. terminal receiptをgenerationへ耐久化した後だけgenerationを`faulted`へ閉じ、その後にwatchを同じ固定fault codeで
   `faulted`へ閉じる。journalを最後に`faulted`へ進める。各境界は同じreceipt／fault codeで冪等回収でき、途中crashを
   successへ丸めない。
8. Claude／Codex bindingは一command一stepとする。terminalを先に観測し、未確認かつ`issue_once`の時だけ正式stop入口を
   一度呼ぶ。unknown／pendingはjournalを非terminalのまま返し、自動restart、別handle探索、他provider fallbackをしない。
9. Supervisorは外部cancelとwatchの明示stopをfaultに変換しない。それ以外のhard failureはcleanup前にfaultをrecordし、
   元の非0errorを維持する。process開始時はprovider runtime生成より先にfault journalを検査し、pendingなら
   `E_SUPERVISOR_GENERATION_FAULT_PENDING`で停止する。
10. 公開status／binding result／CLI errorへlaunch handle、raw receipt、provider outputを出さない。live host stopと
    fault injectionは本変更の自動testへ含めず、Phase O2の個別H gateで受け入れる。

## Acceptance

- active fault、stop発行済みfault、terminal確認後のcrash窓をfocused fixtureで固定する。
- wrong provider／watch／generation／handle／receipt、fault code conflict、未知schemaをfail closedにする。
- provider terminationとmodel result unknownがjournalを先に残し、runtime close／process lock解放後も元errorを維持する。
- fault journalがあるprocess restartはprovider runtime、planned rollover、parent rebind、production stepを呼ばない。
- Claude／Codex bindingの`issue_once -> observe_only -> terminal_confirmed`とunknown非終端をfake hostで固定する。
- TODO完了候補でgeneration、watch、parent launch、fault core／binding、Supervisor関連gateを一度だけ実行する。

## Non-goals

- 実Claude job／Codex threadの停止、意図的provider crash、credential／login。
- fault後の自動restart、takeover、別handle探索、別provider fallback。
- 既存rollover／rebind journalをfault成功へ書き換えること。
