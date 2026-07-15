# ADR 0026: Observer AI出力をno_advisoryまたは一proposalへ固定する

## Status

Accepted for protocol core。Supervisorのpublish前integrationはP4-2／P4-3とともに未実装。

## Context

Observer rootの`AGENTS.md`／`CLAUDE.md`は、同providerのread-only伴走者、既定沈黙、一cycle一件という
静的役割を所有する。しかしprompt上の役割だけでは、modelが通常会話、Markdown、複数候補、実装結果へ
逸脱した時にruntimeが拒否できない。またprovider、target、watch、cycleをmodel自身に再申告させると、
信頼済みlaunch／Supervisor contextと競合する第二の相関情報になる。

## Decision

1. 親authorizationのproviderをそのままObserver providerとして解決し、Claude親にはClaude、Codex親にはCodexを使う。
   未知providerを残レートや暗黙fallbackで補わない。
2. Claude／Codex host adapterは同じ`buildObserverAiPrompt`を使う。promptはroot正本を参照し、可変な
   `observer.child_start.v1`とhost非依存output wireだけを伝える。
3. AI出力schemaを`observer.ai_output.v1`とし、exactな二variantだけを許す。
   - `no_advisory`: `schema`と`outcome`だけ。理由、感想、進捗を許さない。
   - `advisory`: `schema`、`outcome`、一つの`proposal`だけ。
4. proposalは`title`、`body`、`severity`、`category`、`dedupe_key`、1〜16件の`evidence_refs`、
   一つの`suggested_action`へ固定する。severity／categoryとbyte上限はMailbox message契約へ揃える。
5. raw出力は16 KiB以下のJSON object一件とし、Markdown、code fence、前後の説明、配列、未知field、
   制御文字、空文字、過大fieldをfail closedにする。
6. provider、target、watch、parent epoch、generation、cycleはAI出力へ含めない。Supervisorが信頼済みcontextから
   束縛し、schema検証後のcanonical objectからSHA-256 result digestを計算する。
7. 本TaskではMailbox publishまたはsemantic materiality gateを配線しない。P4-2のbounded evidenceとP4-3の
   materiality／novelty／actionability／timing gateを実装した後、外部効果より前に本parserを必須化する。

## Rejected alternatives

- modelの自由文を親またはMailboxへそのまま渡す: 既定沈黙、一件上限、秘密・size境界を強制できない。
- `no_advisory`へ理由を持たせる: 正常進行でも会話を生成し、沈黙契約とcontext budgetを弱める。
- provider／target／watchをmodelに自己申告させる: 信頼境界外の相関情報を重複させる。
- provider別output schemaを持つ: 同じ製品の判断契約をhost wireへ漏らす。

## Evidence

- baseline: 関連host／launch test 23/23 PASS
- focused gate: AI contract＋host／launch test 29/29 PASS
- syntax／diff gate: `npm run check` PASS
- Control: `observer-codex-host-runtime-20260715`、Task `observer-ai-output-contract`
- accepted_at: `2026-07-15T06:59:05.771Z`

## Consequences

- 両providerで同じ「沈黙または一件」のwireを使い、自由形式出力をruntime境界で拒否できる。
- read-onlyは引き続きsandbox／tool allowlist／fingerprint testで強制し、prompt成功を権限証拠にしない。
- P4-1全体はSupervisorのpublish前integrationが完了するまで未完のまま残る。
