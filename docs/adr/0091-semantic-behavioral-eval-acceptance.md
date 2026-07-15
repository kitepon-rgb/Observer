# ADR 0091: semantic behavioral eval fixtureを受け入れる

日付: 2026-07-16

## Status

Accepted for provider-independent P4-3c。design commit `bd2a777`とimplementation commit `a67ce92`を
受け入れる。Claude／Codex実providerのsemantic品質、live配送、credential、H採否を受け入れたことにはしない。

## Accepted behavior

- runtime promptは既定を`no_advisory`とし、具体的claim、実質的影響、一つのaction、未解決かつ適時、
  親が具体的対処中でないことをadvisoryの全条件として明示する。
- 好み、別解、一般論、励まし、軽微な最適化、証拠不足、解決済みは`no_advisory`へ固定する。
  runtimeへregex、単語list、文字数scoreによる意味classifierは追加しない。
- checked-in suiteは正常進行、好み、一般論、証拠不足、対処中、解決済みの抑止6 caseと、
  material verification gap、direct contract breachのadvisory 2 caseをexact schemaで持つ。
- suite validatorはcase ID、criterion網羅、unknown field、evidence ref、期待outcomeを検証し、
  suppression criterionをadvisoryへ、contract breachをwarning以下へ書き換えられない。
- harnessは通常のevidence snapshot／canonical cycle requestを構築し、model-visible callback引数を
  runtime promptとcycle inputだけに限定する。case ID／criterionは第二引数のout-of-band metadataとし、
  modelへ期待ラベルを漏らさない。
- advisory出力はexisting strict parserを通し、category、最低severity、必要evidence refを比較する。
  duplicate、snapshot外、unavailable、truncated、redacted refをadmissibleへ数えない。
- reportはcase ID、pass/fail、固定reason codeだけを持ち、raw output、prompt、cycle input、evidence本文を含めない。
- reference oracleはsuiteとexact同一case集合を要求し、harness green pathと誤outcome／category／severity／ref／
  free-text検出だけを固定する。実provider品質証拠へ読み替えない。

## Verification

- focused: semantic behavioral eval／Observer AI contract — 17 PASS / 0 FAIL / 0 SKIP。
- related: semantic eval、AI contract、evidence snapshot、cycle input、parent launch、Claude／Codex host adapter
  — 62 PASS / 0 FAIL / 0 SKIP。
- static: `npm run check` — PASS。
- 親がcase label leakage、redacted expected ref、suite／oracle同時改変の反対仮説を確認し、全てfail closedへ補正した。
- full regressionと重い独立監査はPhase O2 gateへ集約するため未実行。
- Claude／Codex live evaluator、credential、network、Mailbox dogfoodは未実行。

## Remaining H gate

- P4-4で同じsuiteをproduction-equivalent read-only runtimeのClaude／Codexへ渡し、正常進行の沈黙、
  有益なadvisory、`review_required` soft stopを各providerで採否する。
- H gate前にreference oracle greenを実provider semantic品質実証済みと報告しない。
