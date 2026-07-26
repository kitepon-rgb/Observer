# Changelog

## 0.1.2

- Codex Observer子のapp-serverでユーザー全体のhooks／pluginsを無効化し、親AI向け自動処理によるbootstrap割込みと不要なMCP起動を防ぐ。
- installed production watchがbootstrap完了後に`active`を維持する実運用gateを追加する。

## 0.1.1

- Throughline 0.8.7以降の上位互換runtimeを、固定version一致ではなく安定版SemVerとstrict wire検証で受理する。
- Supervisor異常後もwatchを`faulted`へ確定し、同一watchの診断と停止で回収できるようにする。
- Throughline 0.8.7とCodex CLI 0.144.6のinstalled production経路でwatch開始・観測・停止を検証する。

## 0.1.0

- Claude / Codex親の確定ターンをread-only観測し、証拠付き助言だけを返す初回公開版。
