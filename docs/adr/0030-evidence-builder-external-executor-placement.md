# ADR 0030: evidence builder retryをaiterm Codexへ配置する

日付: 2026-07-15

## Status

Accepted。配置Decisionのimmutable証拠として使用後は変更しない。

## Context

P4-2 builderはCodex native implementerのRun 1を品質不足でrejectし、Run 2は無応答でcancelledとなった。
別会社のComposerをrouting smokeしたがGrok認証待ちとなり、credential/loginのH境界を越えず終了した。
codex-sidecarはObserverに`.codex-sidecar.yml`がなく、dry-runが`CONFIG_NOT_FOUND`でfail loudになった。

aiterm Codexはsession `observer-p4-codex-routing`でmarker応答を完遂し、Codex 0.144.3、
`gpt-5.6-sol/high`、workspace read/write、structured reportをexecution-verifiedとした。通常のimplementerより
上位だが、既定レーンの品質rejectと無応答、ComposerのH境界、sidecar設定不足を根拠に今回だけ上振れする。

aitermはhard/soft capacity値を公開せず、Control placementは`capacity-review-required`となった。
観測inflightは本session一件、Run予算は30分、書込scopeは未受入の2ファイルだけで、他のactive writerはない。

## Decision

親review Decisionにより、同sessionを共有worktreeの非交差direct writerとして一件だけadmitする。
capacity unknownをknownへ偽装せず、追加Runを並行起動しない。Task／Packetのcontext policyは変更しない。

## Consequences

- 実効model／effort上振れとcapacity不明をControlへ明示したまま再実装できる。
- Composer認証、sidecar config追加、会社別rate-aware配置は本Taskの完了へ混ぜず工場TODOで継続する。
