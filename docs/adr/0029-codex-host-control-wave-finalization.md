# ADR 0029: Codex host Control waveを受け入れてsequence 2へ継続する

日付: 2026-07-15

## Status

Accepted。この文書はControl finalizationのimmutable acceptance matrixであり、使用後は変更しない。

## Acceptance matrix

| 範囲 | Task証拠 | 検証・裁定 |
|---|---|---|
| Observer単一project | ADR 0017 | Claude host focused 15/15、static check PASS |
| Codex thread/runtime | ADR 0018 | adapter/runtime/launch focused 21/21 PASS。live UI等は未完 |
| bounded app-server transport | ADR 0019 | fake processのtransport境界を受入。実turnはH未実行 |
| Mailbox current-parent transaction | ADR 0020 | route二重検証とpublish linearizationを受入 |
| 親Stop core | ADR 0021 | fast path coreを受入。live同一turn表示は未完 |
| hook install契約とCLI | ADR 0022、0023 | CLI focused 7/7、static check PASS |
| dotagents adapter receipt | ADR 0024 | adapter focused gate、Python lint PASS |
| 親session単位generation | ADR 0025 | 論理Observerと物理世代交代の設計を受入。state配線は未完 |
| AI固定出力 | ADR 0026 | host統合focused 29/29、static check PASS |
| bounded evidence設計 | ADR 0027 | 32 KiB snapshotと世代上限の設計を受入 |
| evidence builder | ADR 0028 | Run 1 reject、Run 2 cancelled。Taskをsuccessorへ移送し未完を維持 |

## Decision

Control `observer-codex-host-runtime-20260715`のfinalized 14 Taskと、移送cancelした1 Taskを上表どおり
受け入れる。これはObserver全体、P4-2、Codex production host、live H gateの完了を意味しない。
関連focused gateは各TODOで一回ずつ確認済みであり、同じwaveを閉じるためにfull suiteや重い監査を
反復しない。現在地と未完条件は`docs/plan_observer.md`に残す。

## Knowledge return

- Worker Report reject後のretry Run境界: dotagents commits `bd2a372`、`2dbdcd9`。
- native interruptのControl先行順: dotagents commit `f4f453f`。
- evidence builder未完移送: ADR 0028。

## Consequences

本Controlをfinalize/archiveし、同じobjectiveを持つsequence 2 successorでP4-2 builderから再開する。
