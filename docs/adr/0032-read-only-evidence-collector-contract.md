# ADR 0032: evidence collectorをread-only・fail-closedに固定する

日付: 2026-07-15

## Status

Accepted for implementation。受入Decisionへ使用後は変更しない。

## Context

snapshot builderは、検証済みのturn、plan、git、test entryをsection別にredact／boundする。
一方、project filesystemとgit commandからentryを作るcollectorは未実装である。collectorが巨大出力を
独自に切り詰めて成功扱いすると、builderへupstream truncationを伝えられない。shell、pager、external diff、
symlink escapeを許すとread-only境界も崩れる。

## Decision

1. `collectEvidenceInput(request, dependencies?)`はbuilderのexact inputを返し、
   `collectEvidenceSnapshot(request, dependencies?)`だけがその結果を`buildEvidenceSnapshot`へ渡す。
2. requestはtrusted `context`／`turns`、承認済みproject-relative `plan_refs`、既存`test_receipts`、
   絶対`project_root`だけを受理する。plan refは`file:`形式で、canonical realpathがproject root内の
   regular fileである時だけ読む。
3. plan fileはstat後に最大1 MiB、git command stdout／stderrも各1 MiBとする。上限超過、path不在、
   非UTF-8、command失敗を部分本文の成功へ丸めず、該当entryを`available=false`と固定codeで返す。
4. gitはshellを使わず、固定argvでHEAD、porcelain status、unstaged diff、staged diffを収集する。
   pager、external diff、textconv、optional lockを無効化し、project root以外をcwdにしない。
5. source digestは`observer.evidence-source.v1`、section、ref、取得本文をdomain separationしてSHA-256化する。
   secret文字列だけのbare digestをsnapshotへ持ち込まない。secret本文の置換はbuilderだけが担う。
6. test receiptはcollectorで再実行せず、既存のexact receiptをbuilder schemaへ投影する。unknown field、
   availability matrix違反はinvalid requestとしてfail closedにする。
7. collectorはproject、plan、git index、test state、Observer stateへ一切書かない。raw plan／diff／logを
   filesystemへ保存せず、snapshotもdurable保存しない。

## Consequences

- collector固有のsilent truncationをなくし、claim可否をbuilder flagsへ一元化できる。
- 一つの巨大sourceは部分的に採用せずunavailableとなる。必要な抜粋方式は別schema revisionで設計する。
- live repo実行、Supervisor配線、generation stateはこの実装Taskの非目標とする。

