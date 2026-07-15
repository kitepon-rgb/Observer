# ADR 0112: Claude characterizationのhook診断receiptを分離する

日付: 2026-07-16

## Status

Accepted。P5-1b3c非HをP5-1b3d再live Hより先に実装する。既存の
[ADR 0111](0111-claude-live-characterization-blocked.md)は変更しない。

## Context

最初のlive Hではbackground jobを一つだけ起動し、public observeで`done`、cleanup、project
fingerprint不変、host settings不変まで確認したが、`capture.json`が生成されなかった。

Claude Code 2.1.210の保存済み公式仕様と現行CLIを非Hで再確認した結果、次を確認した。

- `Stop`はmain agentが応答を終えた時に発火し、matcherなしで全 occurrenceを対象にする。
- `--settings`は`claude --bg`で起動したbackground sessionへ引き継がれる。
- user／project／managed settingsに`disableAllHooks`または`allowManagedHooksOnly`の阻害設定はない。
- live Hを起動したdaemonの`PATH`からcharacterization executableのshebangが必要とするNodeを
  解決できる。
- harnessのfixtureはStop payloadとexact model resultがともに妥当な場合だけを通し、公開CLIも
  `process.execPath`経由で起動していた。

現行hookはstdin JSON、Stop payload、`last_assistant_message`のどれかが不正なら
`capture.json`を作る前に失敗する。raw logを読まない契約のため、hook未発火、payload不正、
model output不正をlive receiptから区別できない。

## Decision

characterization専用hookは、canonical result captureと別にowner-onlyなdiagnostic receiptを一件作る。
receiptはraw stdin、session ID、result、cwd、prompt、host logを保存せず、次だけを持つ。

- campaign相関とhook invocationのconfirmed証拠
- Stop payload構造、cwd一致、session digestの成立／不成立
- exact Observer result parseとcanonical captureの成立／不成立
- boundedな安定failure code

hook stdinのUTF-8／JSON decodeとfield／result parseはdiagnostic receipt生成の内側で行う。
入力またはresultが不正でも、receiptを安全に永続化できた場合はhook command自体を成功終了し、
判定をreceiptへ残す。owner-only file作成、同一event replayだけの冪等性、別event conflict、未知fileを
消さないcleanupは維持する。

verificationは`hook_invocation`と`result_capture`を別項目にし、result不正をStop未発火へ丸めない。
成功captureがある場合だけterminal exact resultと照合する。direct shebang CLIをfocused testへ追加し、
fixtureが実hook入口を迂回しないようにする。

## Queue

- P5-1b3c: diagnostic receipt／CLI／verify／cleanupとfocused／related gateを非Hで閉じる。
- P5-1b3d: P5-1b3c受入後、別のH承認で一つのbackground jobだけを再characterizeする。
- P5-1b4: P5-1b3dで成立した公開面だけを実装する。先行しない。

再live H、host config変更、credential/login、intentional fault、push、publish、deployは本Decisionの
実装範囲に含めない。
