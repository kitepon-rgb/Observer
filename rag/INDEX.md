# Observer RAG Index

- [Phase 0 調査結果](observer-phase0/phase0-findings.md) — Throughline completed-turn CLI、Observer MCP long-poll、Codex Stop継続の設計根拠（2026-07-14、確度: reproduced / source-verified）
- [Codex hook一次資料メモ](observer-phase0/raw/codex-hooks-sources.md) — 公式Hooksページと0.144.3実装ソースの取得記録（2026-07-14）
- [親provider launcher調査](observer-launcher/parent-provider-launch.md) — Codex native subagent／Claude background sessionを親所有の二相起動へ写像した根拠（2026-07-15、確度: source-verified / reproduced）
- [Codex Observer read-only境界](observer-launcher/codex-readonly-boundary.md) — 親live permissionがcustom agent sandboxを上書きする実測と、persistent app-server thread候補の未検証gate（2026-07-15、確度: source-verified / reproduced）
- [Codex app-server Observer runtime契約](codex-app-server/runtime-contract.md) — thread／turnのcwd・read-only・persistent handle・interrupt terminal・AGENTS.md読込に加え、0.144.6のempty-rollout競合とisolated `CODEX_HOME`を固定（2026-07-15、2026-07-26追試、確度: official-primary / local-schema-verified / reproduced）
- [Claude background Observer read-only境界](observer-launcher/claude-background-readonly.md) — 組込みtool allowlistによるread／一回のwrite拒否、job lifecycle、process全体の未検証境界、可変長argvとlate logsの罠（2026-07-15、確度: partially reproduced）
- [Claude background runtime契約](claude-background-runtime/runtime-contract.md) — `--bg`のshort ID出力、任意のsupervisor起動行、cwd、公開管理handleをObserver実行層へ写像した公式根拠（2026-07-15、確度: official-primary）
- [ADR 0011: Claude process境界](../docs/adr/0011-claude-process-boundary-characterization.md) — 75秒継続、実行中stop、子process消滅、project fingerprint不変と再stop確認不能（2026-07-15、確度: reproduced）
