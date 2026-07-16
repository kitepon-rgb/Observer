# ADR 0136: exact AI response contractを各cycle requestへ同梱する

日付: 2026-07-16

## Status

Accepted。実装gateはgreen。queue 19eの実Claude再検証を受入れへ残す。

## Context

queue 19eの実managed Claudeで初回prompt、Stop、exact result回収は成立したが、resultはJSON object一件で
なく`E_OBSERVER_AI_OUTPUT_INVALID`となった。bootstrap promptにはstrict output契約がある一方、
各cycle turnは
`instruction`、`output_schema`、evidenceだけを持ち、single object、default、exact variant、禁止形式を
明示していない。永続sessionの文脈は維持するが、出力境界を過去turnの想起だけへ依存させてはならない。

## Decision

1. `observer.cycle_request.v1`へ`response_contract`を追加し、各model turnでexact contractを可視にする。
2. contractはsingle JSON object、default no_advisory、exact二outcome、advisory proposalの
   exact field、
   severity／category許可値、Markdown／code fence／前後説明／unknown field禁止を含む。
3. response contractを含むcanonical cycle request全体を既存input digestとmodel visible bytesへ束縛する。
4. Claude専用prefixやparser fallbackにせず、Claude／Codex共通のhost-neutral cycle requestへ適用する。
5. strict `observer.ai_output.v1` parser、16 KiB上限、provider exact result、journal契約は変更しない。

## Acceptance

- cycle input testでresponse contractのexact shape、canonicalization、digest／bytes束縛を固定する。
- AI contract testでbootstrapとcycleの許可enum・exact variantが同じ正本から生成されることを固定する。
- Claude model operationとSupervisor関連gateを一度通す。
- 修理済みcandidateの実Claudeでstrict output parseとcycle commitを確認する。
- raw model output、prompt、session ID、credentialは証拠へ保存しない。

## Gate evidence

- focused cycle input＋AI contract＋Claude operation: 12 passed、0 failed、0 skipped。
- related cycle＋Supervisor＋E2E＋semantic evaluator: 52 passed、0 failed、0 skipped。
- 実Claude strict parseはqueue 19e live Hで行い、fixture greenへ代入しない。
