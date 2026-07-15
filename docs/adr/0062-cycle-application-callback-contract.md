# ADR 0062: cycle application callbackをdurable operationへ束縛する

日付: 2026-07-15

## Status

Accepted for implementation。外部Supervisor production callerのうち、`applyCycle`／`finalizeAppliedCycle`だけを
本Taskで閉じる。provider routing、公開CLI、live host requestは後続Taskに残す。

## Context

`runSupervisorCycle`はgeneric model operationを`completed`へ保存した後、production `applyCycle` callbackを要求する。
しかし現在はtest callbackしかなく、`observer.ai_output.v1`のadvisoryをMailboxへ適用する実入口が無い。

advisory messageの`created_at`／`expires_at`をcallback実行時刻から作ると、Mailbox publish後・generic `applied`保存前の
crash recoveryで同じoperationから異なるcontent digestを生成し、record-first publish receiptとconflictする。
raw outputやmessage本文を新しいapply journalへ複製する必要はない。generic model operationはcanonical output、
completed output digest、作成時刻をすでに耐久化している。

## Decision

1. `applyCycleOutput`はraw-free operation receipt、canonical output、再構成済みcanonical cycle inputを受ける。
   cycle inputのdigest／model-visible bytesをoperationへ照合し、そのevidence context内のtarget／watch／cycle／provider／
   parent threadだけを配送identityとして使う。callerが別引数で渡すthread digestを信頼しない。
   generic model operationを再読し、operation／target／watch／generation／cycle／input／byte数／provider／statusと
   canonical output digestの完全一致を確認する。callback引数だけを信頼しない。
2. `no_advisory`はMailbox外部効果を作らない。domain `observer.no_advisory_apply.v1`、operation ID、durable
   completed output digestから決定的なbare SHA-256 result digestを作る。
3. `advisory`はoperation ID由来のmessage ID、durable operation `created_at`、そこから24時間後の`expires_at`、
   target／parent thread、proposal一件からstrict messageを再構成し、`publishOperationMessage`だけを呼ぶ。
   result digestはpublished content digestのbare hexとする。
4. application時点ですでに24時間の有効期限を過ぎているmessageはpublishせずfail loudにする。現在時刻から
   新しい期限を作ってreplayを別contentへ変えない。
5. `finalizeCycleApplication`はgeneric operationを再読し、`applied`とexact resultを確認する。
   `no_advisory`は決定的digest一致後にno-op、`advisory`はoperation ID／message ID／applied content digestで
   `cleanupOperationPublishReceipt`を呼ぶ。generic `applied`前のcleanupは既存Mailbox storeが拒否する。
6. callback returnへmessage本文、proposal、provider outputを含めない。provider routing、wait、cursor commit、
   generation rolloverは本moduleの責務外とする。

## Acceptance

- no-advisoryの決定的result、advisoryの一回publishと同内容replay、cycle inputと異なるthread／output／identity拒否をfocused testで固定する。
- publish後・generic applied前のreplayが同じcontent digestを返し、applied後のfinalizeだけがpublish receiptをcleanupする。
- 期限切れを新しいtimestampへfallbackせず拒否する。
- Supervisor related gateはTODO完了候補で一度だけ実行し、full regressionはPhase gateへ集約する。
