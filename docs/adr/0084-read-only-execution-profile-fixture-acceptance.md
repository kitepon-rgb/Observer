# ADR 0084: read-only実行profileの非H fixtureを受け入れる

日付: 2026-07-16

## Status

Accepted for non-H fixture。design commit `74c8228`とtest commit `2168199`を受け入れる。
実Claude／Codex hostのproject write拒否、settings／hooks／plugins process隔離、credential、
hook trust、crash recoveryを受け入れたことにはしない。

## Accepted evidence

- Claude invocationはruntime rootをhost cwdに持ち、空のsetting sources、skills／Chrome無効、
  strict MCP、exact empty `--tools`／`--allowedTools`を固定する。
- Codex thread／turnはruntime root cwd、approval `never`、read-only、network offを固定する。
- temp git projectのHEAD、index、status、tracked／untracked file内容、modeを同じfingerprintへ含める。
- 外部Supervisor所有のdurable cycle application callbackでadvisoryを適用し、project fingerprintを
  変えずにObserver state root配下へMailbox messageと`published` receiptを作る。
- receiptはoperation ID、message ID、target ID、content digestをexact照合し、単なるfile存在を
  publish成功へ読み替えない。
- git fingerprint command失敗を例外として伝播し、不変扱いへ丸めない。

## Verification

- focused: `node --test test/read-only-execution-profile.test.mjs`
  — 3 PASS / 0 FAIL / 0 SKIP。
- related: Claude／Codex host adapter・runtime、cycle application、Mailbox、
  Supervisor production step、
  本fixture — 60 PASS / 0 FAIL / 0 SKIP。
- static: `npm run check` — PASS。
- full regressionはPhase O2 gateへ集約するため未実行。
- 実host、credential、network、意図的project writeは未実行。

## Remaining P2-5 gates

- Codex live HでUI、65秒超turn、adapter crash resume、interrupt／stop、project write拒否を実証する。
- Claude live Hで`--safe-mode`とbackground agent定義、認証維持、隔離Stop hook、project write拒否、
  re-stop、daemon／adapter crash resultを実証する。
- `--safe-mode`が公開background契約と両立しない場合も、`--bare`、private protocol、別job、
  prompt規律へfallbackしない。
