# ADR 0023: parent Stop hook config CLIの実装確定値

## Status

Accepted。Observer側実装済み。dotagents adapterとlive Host適用は未完了。

## Context

ADR 0022はObserverとdotagentsの所有境界、fragmentの意味、verifier statusを固定したが、公開CLIの引数、
candidate transport、timeout値、JSON外形は未確定だった。実装者へ未確定値を委ねず、親が既存Observer CLIと
Claude／Codex hook schemaを照合して実装値を固定した。

## Decision

1. 公開binは`observer-hook-config`とする。
2. fragment生成は`fragment --provider <claude|codex> --executable <absolute-path>`、検証は
   `verify --provider <claude|codex> --executable <absolute-path>`とし、後者のcandidate全設定JSONは最大1 MiBの
   strict UTF-8 stdinで受ける。
3. commandは`<absolute-path> --provider <provider>`、timeoutは両providerとも5秒に固定する。
4. Claude entryは`{hooks:[{type,command,timeout}]}`、Codex entryは
   `{type,command,timeoutSec,async:false,statusMessage:null}`のexact shapeとする。
5. fragment schemaは`observer.parent_stop_hook_fragment.v1`、verification schemaは
   `observer.parent_stop_hook_verification.v1`とする。
6. candidateの`hooks.Stop`未定義は`missing`、存在する非配列はinvalidとする。他製品entryはtarget countと
   canonical判定から除外する。
7. executableはabsoluteな実在regular fileかつ実行可能でなければfail closedとする。macOS v1では空白、制御文字、
   単一／二重引用符を含むpathを拒否し、shell quotingへfallbackしない。

## Evidence

- `node --test test/parent-stop-hook-config.test.mjs` — 7/7 PASS。
- `npm run check` — PASS。
- Control `observer-codex-host-runtime-20260715`: Worker Report strict import revision 28、親受入 revision 29。

## Consequences

- dotagentsはこのCLIのfragmentをconsumeし、prospective candidateを同CLIで検証できる。
- ObserverはHost設定transactionを所有せず、dotagentsはObserverのMailbox／routing／renderを再実装しない。
- actual apply、hook trust、実Host発火は引き続きH gateである。
