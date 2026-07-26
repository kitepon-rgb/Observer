# ADR 0146: truncated completed-turnの元全文digest境界を補正する

日付: 2026-07-26

## Status

Accepted。P5-4 production watch smokeで露出したevidence境界の補正契約とする。

## Context

Throughlineのcompleted-turn projectionは、本文を上限内へ短縮した時も`user_sha256`／
`assistant_sha256`へ元全文のdigestを保持し、`truncated=true`を返す。Observerは短縮後本文を
元全文digestと比較していたため、長い正規turnで`E_EVIDENCE_SNAPSHOT_INVALID`になった。

## Decision

1. `truncated=false`のturnは本文と元全文digestの完全一致を従来どおり必須にする。
2. `truncated=true`のturnは、Throughlineのstrict wire、source identity、truncated flagを保持して
   evidence snapshotへ取り込む。短縮本文を元全文digestと比較しない。
3. truncated flagを落とさず、既存semantic gateによりtruncated evidenceをadvisory根拠へ使わせない。
4. `truncated=false`のdigest不一致拒否testを維持し、truncated=trueの元全文digest受理testを追加する。

## Acceptance

- 長い正規completed turnをorientation snapshotへ取り込める。
- 非truncated本文改変は引き続き拒否する。
- truncated evidenceはsnapshot flagsへ残り、完全な根拠として扱われない。

## Rollback

本ADRと対応実装をrevertし、P5-4 production watch smokeを未完へ戻す。
