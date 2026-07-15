# ADR 0022: hook契約はObserver、全端末設定transactionはdotagentsが所有する

## Status

Accepted。Observer `hook-config`とdotagents adapterの実装は未完了。

## Context

Observerは親Stop payload、Mailbox routing、advisory wireを所有する。一方、Claude／Codexのuser設定は端末全体で
複数製品のhookを合成する共有面であり、dotagentsが全端末の導入、更新、互換、rollbackを統括している。

ObserverがHost設定を直接編集すると、既存hookの保持、Claude／Codex二設定のtransaction、multi-device rolloutが
Observerへ漏れる。逆にdotagentsがObserver entryを手書きで複製すると、provider wire変更時に製品契約と配布adapterがdriftする。

## Decision

1. Observerはversioned `observer.parent_stop_hook_fragment.v1`を生成するread-only `hook-config`入口を持つ。
2. 入力は`claude|codex`とabsolute `observer-parent-stop-hook` executable pathとする。macOS v1ではshell quotingを
   実装せず、空白、制御文字、引用符を含むpathをfail closedで拒否する。
3. Claudeは`timeout`を持つstandalone Stop entry、Codexは`timeoutSec`、`async=false`、`statusMessage=null`を持つ
   standalone Stop entryをcanonical形とする。いずれもmatcherを持たない。
4. Observer verifierはcandidate JSONをread-onlyで検査し、`missing|duplicate|noncanonical|canonical`を返す。
   対象command以外のentryを変更対象または失敗理由へ含めない。
5. dotagents adapterはObserver CLIからfragmentを取得し、Claude settingsとCodex hooksへ各一件に正規化する。
   既存hookを保持し、既定dry-run、apply時backup、二file prepare、atomic replace、失敗時rollbackを行う。
6. dotagentsはObserverのmessage／routing／renderを再実装せず、ObserverはHost config transactionを実装しない。
7. actual apply、hook trust、実火はH gateへ残す。隔離HOMEでのapply／rollback testは外部状態を変えないためAで行える。

## Consequences

- Observer projectの正典が製品固有のStop entryを支配し、dotagentsが複数端末・複数製品の共有設定を安全に合成できる。
- v1はmacOSの空白なしabsolute pathに限定される。Windows／空白path対応はHost command escapingを実証するまで未対応である。
- Observer CLI不在、fragment schema不一致、candidate config不正時はdotagents側もapplyせずfail loudになる。
