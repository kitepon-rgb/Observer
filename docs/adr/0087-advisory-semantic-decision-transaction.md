# ADR 0087: advisory semantic decisionを二層gateへ固定する

日付: 2026-07-16

## Status

Accepted for staged implementation。P4-3を、runtimeが決定論的に強制するgateと、Observer AIが行う
意味判断へ分離する。本ADRのruntime coreだけでP4-3全体を完了扱いしない。

## Context

現行`applyCycleOutput`はstrict AI outputとcycle inputのidentityを検証するが、advisoryをそのまま
Mailboxへpublishする。evidence refの適格性、cross-operation dedupe、cooldownは未実装である。

一方、materiality、actionability、「親が具体的に対処中か」、「今伝える価値」は文章とbounded
evidenceの意味判断である。単語list、文字数、category別ruleで判定すると、一般論を通し、有益な短い
助言を落とす偽のsemantic gateになる。runtimeが証明できる範囲とmodel behavioral evalを混同しない。

独立反証では、初案の24時間cooldown、保持期間中のsame-evidence永久抑止、件数capによるactive
cooldown削除、severity昇格の抑止、semantic／Mailbox lockの未定義を棄却した。

## Decision

### 1. 二層gate

1. Observer AI semantic decisionは既存`observer.ai_output.v1`の`no_advisory | advisory`一件で行う。
   materiality、actionability、semantic timing、親が対処中かはこの層の責務とし、P4-3 behavioral
   evalで好み、一般論、対処中のfixtureを`no_advisory`にする。
2. runtime deterministic gateは、advisoryに対してevidence admissibility、
   exact operation replay、
   dedupe、cooldown、severity escalation、record-first stateだけを強制する。
3. runtime gateは意味判断を完全検証したと主張しない。behavioral evalが未完ならP4-3は未完である。

### 2. evidence admissibility

1. proposalの`evidence_refs`は重複を許さない。
2. snapshotのturns／plan／git／tests全体で全refが一意でなければ、ambiguous inputとしてfail loudにする。
3. proposalの各refはexactly one entryへ解決し、`available=true`、`truncated=false`、
   `redacted=false`を全て満たす必要がある。欠損または不適格refを使うadvisoryは
   `suppressed / evidence_ineligible`として記録し、Mailboxを作らない。
4. evidence fingerprintは採用refの`section / ref / source_digest`を順序正規化し、domain-separated
   SHA-256にする。raw ref、source本文、dedupe keyをstateへ保存しない。

### 3. dedupe／cooldown

1. same operation IDはhistoryに関係なくcurrent decisionをexact replayし、semantic判定を再実行しない。
2. 別operationの同じdedupe keyは、直近accepted decisionから60分をcooldownとする。
   60分はv1の最大通常wait window一回に合わせた固定製品値で、message TTLやhistory retentionから導かない。
3. cooldown中でもseverityが`info -> warning -> review_required`の順に上がる場合はacceptを許す。
   同じか低いseverityは、新evidenceであっても`suppressed / cooldown_active`にする。
4. cooldown終了後はsame key／same evidenceも新cycleで再評価できる。history retentionをsuppression期間にしない。
5. AI生成dedupe keyを唯一の真実にせず、decisionにはproposal digest、evidence fingerprint、category、severityも
   束縛する。ただし異なるdedupe keyの意味的同一性を文字列heuristicで推測しない。

### 4. record-first transaction

1. target単位で`watches/<target>/semantic-decision.json`、
   `semantic-history.json`、専用nonce lockを所有する。
2. current decisionはidentity、input／output／proposal digest、dedupe key digest、
   evidence fingerprint、
   category、severity、decision、reason、result digest、時刻だけを持ち、proposal本文やraw refを保存しない。
3. candidate messageはdecision保存前に`sealMessage`でschema、期限、digest、secretを検証する。
   invalid messageをaccepted current decisionとして残さない。
4. 状態は`accepted_pending_publish -> accepted_published`または`suppressed`とする。
   decisionを先にatomic保存し、acceptedだけ既存`publishOperationMessage`へ渡す。
5. semantic lock中にMailbox consumer lockへ入らない。decision準備後にsemantic lockを解放してpublishし、
   publish receipt回収後にsemantic lockを再取得して`accepted_published`へ進める。
6. publish後・decision更新前crashは同じoperation messageのexact replayだけで回収する。
   別message、別dedupe key、別operationへfallbackしない。
7. suppressedは専用reasonとdomain-separated result digestを返し、`no_advisory`へ偽装しない。

### 5. finalization／retention

1. `finalizeCycleApplication`はdurable semantic decisionを正本にする。
   acceptedだけMailbox publish receiptを
   cleanupし、suppressedは外部receiptなしでfinalizeする。
2. accepted finalizationはsemantic history容量を非変更preflightし、saturationならMailbox cleanup前に停止する。
   Mailbox lock解放後にsemantic finalizationを行う。crash replayではhistoryの同一operation receiptを
   exact照合し、単なるcurrent欠損をfinalizedへ丸めない。
3. historyはdigest-only decisionを30日・最大1000件へboundする。ただしcurrent operation、
   未finalize、cooldown中のaccepted decisionは日数／件数cleanup対象外にする。
4. 保護対象だけでcapへ達した場合はactive entryを消さず、structured saturation errorで停止する。

## Implementation order

1. host-neutral semantic decision storeとfocused crash／retention fixture。
2. `applyCycleOutput`／`finalizeCycleApplication`へのmessage seal前後transaction統合。
3. semantic behavioral eval契約とfixture。実providerでの採否はP4-4 H gateへ残す。

## Rejected alternatives

- 単語listや文字数でmateriality／actionabilityを判定する: 意味を検証せず誤抑止する。
- same evidenceを30日抑止する: retentionをcooldownへ流用し、再通知価値を失う。
- 新evidenceも24時間抑止する: 根拠がなく、severity昇格とsoft stopを殺す。
- current decisionを持たずhistoryだけへappendする: same operation replayとpublish crash窓を区別できない。
- semantic lock中にMailbox publishする: lock順の循環と回収不能を招く。

## Acceptance

- runtime core、cycle integration、behavioral evalを別TODO／別commitで受け入れる。
- duplicate proposal ref、ambiguous snapshot ref、不適格evidence、cooldown、
  severity escalation、clock rollback、
  saturation、全crash windowをfocused fixtureで固定する。
- same operation replay、既存Mailbox exact replay、no-advisory result、provider cleanup順を維持する。
- behavioral eval未実施をP4-3完了または「意味gate実装済み」と報告しない。
