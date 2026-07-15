# ADR 0027: 一cycleのevidence snapshotを32 KiBへ制限する

## Status

Accepted for design。builder、collector、generation counterは未実装。

## Context

Throughlineのcompleted-turn feedは各body 1,200文字、各page合計4,000文字へ既にboundされている。
しかしdelta paginationを全page結合した一cycle全体、plan、git diff、test logを合わせたObserver入力には
別のhard ceilingがない。parent session単位の論理Observerを採用しても、一つの物理host sessionへ
入力を積み続ければcontext爆発は残る。

raw turn、patch、test logをそのままdurable handoffにすると、secretと巨大logを第二の記憶正本へ複製する。
一方、digestだけではObserverがclaimを検証できない。boundedな一時snapshotと本文なしreceiptを分ける必要がある。

## Decision

1. host非依存schemaを`observer.evidence_snapshot.v1`とし、canonical JSONのUTF-8 serialized sizeを
   32 KiB以下へhard制限する。snapshotは一cycle中の一時入力で、raw object／JSONを保存しない。
2. trusted contextはtarget ID、watch ID、parent host／thread digest、cycle ID、cursor digestを持つ。
   raw session ID、opaque cursor本文、target絶対pathをAIのevidence refへ含めない。
3. evidenceを次のsectionへ分離する。
   - `turns`: Throughlineのexact turn itemを検証し、最新側から最大12 KiB。
   - `plan`: Supervisorが承認したproject-relative refだけを最大4件、合計6 KiB。
   - `git`: HEAD、bounded status、diffstat、必要最小patch excerptを合計8 KiB。full patchを保存しない。
   - `tests`: 既存のcommand／outcome／observed-at／digest receiptだけを最大16件、合計4 KiB。raw logを含めない。
4. 各entryはstable evidence ref、source digest、`available`、`truncated`、`redacted`を持つ。
   upstream truncation、section budget超過、collector unavailableを空配列の成功へ丸めない。
5. credentialらしい文字列は固定markerへ置換し`redacted=true`とする。元secretや元secretだけのdigestを
   snapshot／receiptへ残さない。redactedまたはtruncated entryをadvisoryの根拠refとして採用しない。
6. snapshot全体のcanonical digestはredaction／bounding後のobjectから計算する。durable receiptへ保存できるのは
   schema、相関ID、digest、serialized bytes、section件数、omitted／truncated／redacted flagsだけである。
7. 一つの物理host generationは最大8 completed observation cycle、かつObserver所有model-visible payload累積
   256 KiB未満とする。protocol prompt、MCP structured response、snapshot、AI outputのUTF-8 bytesを加算し、
   次cycleでどちらかへ達する場合はcycle開始前にplanned rolloverする。
8. providerが公開する信頼可能なcontext usageは早期rolloverの補助証拠にできるが、非公開token量の推測を
   hard gateまたは成功証拠にしない。

## Rejected alternatives

- Throughline page上限だけを一cycle上限とみなす: paginationと他sectionを合算できない。
- modelへ必要なfile／diff／logを自由に読ませる: bytes、secret、重複読込をSupervisorが把握できない。
- snapshotをgeneration handoffとして丸ごと保存する: raw親本文とpatchを第二のdurable memoryへ複製する。
- 一律要約だけを渡す: claimを再検証できるstable refとdigestを失う。
- providerの残context推定だけでrolloverする: provider差と非公開仕様によりfail-closed thresholdにならない。

## Consequences

- 一cycleと一generationのObserver所有context量をdeterministicにboundできる。
- 32 KiB snapshotは全project状態の完全複製ではない。省略・redactionを明示し、含まれない証拠について断定しない。
- builder、read-only collector、semantic gate、generation state／rolloverは別TODOとして残る。
- app上の物理thread／jobは世代交代で増え得るが、すべて同じObserver projectに属する。
