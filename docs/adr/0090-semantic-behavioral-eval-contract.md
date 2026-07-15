# ADR 0090: semantic behavioral eval契約を固定する

日付: 2026-07-16

## Status

Accepted for implementation。P4-3cではprovider非依存のstrict eval suite、実行harness、reference oracleを
実装する。Claude／Codex実providerの採否、credential、live requestはP4-4 H gateへ残す。

## Context

P4-3a／P4-3bはevidence admissibility、exact replay、dedupe、cooldown、record-first publishを
決定論的に強制する。しかしmateriality、actionability、semantic timing、親が具体的に対処中かは
文章とbounded evidenceの意味判断であり、runtimeの単語listや文字数で完全検証できない。

fixtureに期待結果だけを書いて終えると、harnessが誤advisoryを検出できることも、実providerが同じ契約へ
接続できることも証明しない。一方、このTaskでlive providerを呼ぶとP4-4のH境界を先食いする。

## Decision

### 1. prompt policy

Observer AIのcycle指示へ次の順序を明記する。

1. 既定は`no_advisory`。
2. claimがbounded evidenceから具体的に確認できる。
3. 放置時に目的、scope、安全、受入条件、検証のいずれかへ実質的な影響がある。
4. 親が検討できる一つの具体的行動がある。
5. 未解決で今伝える価値があり、親が認識して具体的な対処を開始していない。
6. 単なる好み、別解、一般論、励まし、軽微な最適化ではない。

一つでも満たさなければexact `no_advisory`とする。runtimeへ同じ判断を模倣する文字列heuristicは追加しない。

### 2. strict eval suite

checked-in suiteはschema、case ID、criterion、bounded evidence input、期待結果をexact fieldで持つ。
最低限、次を別caseにする。

- 正常進行、単なる好み、一般論、証拠不足、親が具体的に対処中、既に解決済み
  → `no_advisory`。
- 未対処のmaterial verification gap
  → `advisory / verification_gap / warning以上`。
- 次変更前に確認すべき直接的なcontract breach
  → `advisory / acceptance_mismatch / review_required`。

advisory期待はcategory、最低severity、必要evidence refsを固定する。title／body／suggested action／dedupe keyの
逐語一致は要求せず、strict output parserとbounded evidence gateへ委ねる。

### 3. executable harness

1. harnessは各fixtureから通常の`observer.evidence_snapshot.v1`と`observer.cycle_request.v1`を構築する。
2. evaluator callbackへ固定runtime promptとcanonical cycle request一件だけを渡す。
3. raw結果を既存`parseObserverAiOutput`でstrict検証し、期待outcome、category、severity、必要refを比較する。
4. case欠損、重複ID、未知field、inadmissible期待ref、自由文、Markdown、複数候補をfail loudにする。
5. pass/fail reportはcase IDとbounded reason codeだけを持ち、raw model outputやsnapshot本文を耐久保存しない。

### 4. reference oracleとH境界

checked-in reference oracleはharness自身のgreen pathとnegative mutation検出を固定するためのものとする。
これはClaude／Codexのsemantic品質証拠ではない。P4-4では同じsuiteを両providerのproduction-equivalent
read-only runtimeへ渡し、no-advisory caseと有益なadvisory／soft stopをlive採否する。

## Rejected alternatives

- runtime単語list、regex、文字数scoreで意味を判定する: 一般論を通し、有益な短い助言を落とす。
- expected proseの逐語一致: provider表現差を品質差へ誤変換する。
- fixture expected値を直接返すだけのtest: evaluator接続と誤出力検出を証明しない。
- P4-3cでClaude／Codexをlive実行する: credential／live H境界をP4-4から先食いする。

## Acceptance

- prompt、suite schema、harness、reference oracleを別々に検証する。
- suppression 6種とadvisory 2種を最低限含める。
- reference oracleは全case green、各outcome／category／severity／ref mutationはfocused testでredになる。
- 実provider未実行を明記し、P4-4前にsemantic品質実証済みと報告しない。
