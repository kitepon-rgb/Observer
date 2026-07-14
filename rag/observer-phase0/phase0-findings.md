# Observer Phase 0 調査結果

**調査日:** 2026-07-14

**対象:** Observer / Throughline 0.6.3 / Codex CLI 0.144.3

**確度:** source-verified + reproduced

## 結論

Observer v1は、Throughlineが提供するproject-scopedのcompleted-only read / wait契約を使う。Codexの完了証拠はrolloutの`task_complete`とし、進行中turnを含みうる現行DBの`bodies`件数や`updated_at`をcursorにしない。

待機のAI向けtransportはObserver所有MCPの`wait_for_turn_change`とする。MCP adapterはThroughlineのJSON-only wait / read CLIだけを呼び、completed-turn判定とcursorはThroughlineが所有する。一回の呼出しは最大3600秒、Codexの`tool_timeout_sec`は3700秒以上とする。Observer自身の継続はproject-local Stop hookの`decision:"block"`で行い、親への手紙も親Stop hookの同じ機構でadvisory promptとして届ける。

## 現行Throughline

- repo: `/Users/kite/Developer/Throughline`
- version: 0.6.3、Node.js 22.13以上、ESM
- baseline: `npm test`は616 tests中615 pass、1 skip、0 fail
- DB: `~/.throughline/throughline.db`、schema v8
- read-only入口: `throughline auditor-context`
- Codex capture: `UserPromptSubmit`、`PostToolUse`、`Stop`の各hookからrolloutを再投影する
- thread discovery: project cwdでrollout候補を絞り、現行実装はrollout mtime順に並べる

`auditor-context`はread-onlyでDBを開き、session / project / user hash / assistant hashを照合する。Codexではturn ordinalがrollbackやin-flight除外で動きうるため、sessionと両本文hashをfreshness根拠にする。Observer向けには、project pathだけから最新の完了済みthreadを解決し、opaque cursor差分を返す薄い公開projectionが追加で必要である。

## 完了turnとDBの差

現行親threadが進行中の時点で同じrolloutとDBを比較した。

```text
rollout default active turns: 27
rollout completed-only turns: 26
Throughline DB projected turns: 27
```

したがって以下は不採用:

- `sessions.updated_at`をcursorにする
- `bodies`の最大IDまたは件数をcursorにする
- Throughline Stop hookが一度走ったことを完了証拠にする

Codex Stop hookはhostの`task_complete`より前に走る。別のStop hookがcontinuationを要求する可能性もあるため、Throughline waitはrolloutで最終的な`task_complete`を確認するまで起床通知を返してはならない。

## 採用するThroughline projection

1. 指定projectに属するCodex rollout候補を列挙する。
2. 各rolloutを`includeInFlightTurn:false`相当で解析する。
3. 最新の完了turn時刻を持つthreadを現在親として選ぶ。
4. thread ID、完了pair数、pair chain digest、project identityからopaque cursorを作る。
5. waitはcursorが変わるまでThroughline内部で短いread / sleepを繰り返す。
6. changed後のreadは既存`auditor-context`相当のfreshness照合を通し、進行中tailを除外する。

cursorはObserverが解釈しない。same-thread append、thread switch、rollback / prefix mismatchをThroughlineが判定し、`delta`、`thread_switched`、`resync_required`を区別する。監視開始後のbounded上限超過はopaque page tokenで全件回収し、欠落を成功扱いしない。

DB/WALのpollingはObserverではなくThroughline processの内部実装である。各read transactionを短く閉じれば、wait登録との競合窓は「即時再確認 + 周期再確認」で失われない。fs watcherや常駐daemonはv1に不要。

## Codex Stop契約

公式仕様、0.144.3実装、隔離probeの三つで確認した。

- event名は`Stop`
- payloadは`session_id`、`turn_id`、`cwd`、`stop_hook_active`、`last_assistant_message`等を持つ
- exit 0のplain stdoutは不正。JSONを返す
- `{"decision":"block","reason":"..."}`はreasonを新しいhook promptとして同じCodex turnを継続する
- `continue:false`はblockより優先する
- exit 2 + stderrも継続できるが、v1は型検証できるJSONを使う

隔離probeでは最初のassistant message `FIRST`のStopでblockし、同じturn内に`CONTINUED`が生成された後、一度だけ`turn.completed`となった。永続hook設定は変更せず、probe scriptも削除した。

Observerの一時間timeout後の「次のターン」は、Codex wire上は新規user turnではなく同じturn内の次の監視サイクルとなる。Stop hookは待機せず、active watch stateの時だけ再開promptを返す。

## 待機transport

候補比較:

| 候補 | 判定 | 理由 |
|---|---|---|
| shell CLI long wait | 診断用 | Codexのbackground terminal pollは現行tool面で最大5分。AIが周期的にpollし直すため睡眠としては弱い |
| Observer MCP → Throughline JSON CLI | v1採用 | 一つのtool callを保持しつつ、MCP transportとcompleted-turn stateの所有を分離できる |
| Throughline本体がMCP serverを所有 | 不採用 | 現行Throughlineは外部依存ゼロでMCP surfaceを持たず、feed追加以上に責務を広げる |
| app-server Supervisor | v1不採用 | 真の別turnを作れるが、thread制御・再接続・認証まで所有範囲が広がる |
| legacy `notify` | 不採用 | user configの単一argvで現端末ではComputer Useが使用中。共有hookとして合成できない |

Codex 0.144.3はsession configで`mcp_servers.<name>.tool_timeout_sec=3700`を受理することを確認した。隔離MCP serverの65秒timerをCodexから呼び、tool callが正常完了することも実測した。サーバー側の`Date.now()`差分は時計境界で64,999msだったが、検証対象である「既定60秒を超えてhostが同じMCP callを保持できること」は満たした。1ms境界を目的外の再試験で追わない。

最初のprobeは即時toolを含めて`user cancelled MCP tool call`になった。0.144.3 sourceを確認すると、注釈なしcustom MCP toolの既定`AppToolApproval::Auto`は承認要求になり、非対話`codex exec`ではcancelされる。probeでは`default_tools_approval_mode="approve"`で正常化した。製品ではserver全体を許可せず、Observer MCP adapterがwait / readへread-only注釈を付け、設定がその二toolだけをallowlistし、必要ならtool単位で`approval_mode="approve"`を指定する。

## Observer技術候補

- runtime: Throughlineと揃えたNode.js 22.13以上 / ESM
- test: `node --test`、package gateは`npm test`
- Observer folderは現時点でgit repoではなく、package / CI / runtime codeも未作成
- Observerは別folderをcwdにし、workspace-writeはObserver codeと明示state dirだけへ許可する。監視projectはcwd外としてread-onlyに保つ
- v1 supported platformはmacOS。state rootは`~/Library/Application Support/Observer`、directory `0700`、file `0600`とし、Linux / Windowsは未検証表示にする

## Phase 0最終裁定

- completed-turn feedのwire contractはThroughlineの`docs/14_observer_completed_turn_feed_plan.md`へ正本化した。
- Observer v1はmacOSをsupportedとし、state / Mailboxを`~/Library/Application Support/Observer`へowner-onlyで置く。Linux / Windowsは実証までunsupported / unverifiedとする。
- 正常receiptは`emitted_unacked`とし、Host ackがないv1で`delivered`を名乗らない。
- Throughline本体へMCP serverを追加せず、ThroughlineはJSON CLI、ObserverはAI向けMCP adapterを所有する。
- Stop continuationは正常changed処理またはtimeout後だけ継続する。transport / schema / state failureではwatchをfaultedにし、構造的に解消不能な条件でAI cycleを反復しない。

Phase 0の調査blockerは残っていない。Throughline実装とObserver scaffoldはそれぞれのplan gateに従って開始できる。

## 反証

「現行DBだけを見れば十分」という仮説は、進行中turnを1件多く含む実測で棄却した。「Stop hookを完了通知として使える」という仮説も、Stop block後に同じturnが継続する0.144.3実装とprobeで棄却した。「Throughline自身がMCP serverまで所有すべき」という仮説は、現行の外部依存ゼロ・CLI中心境界に対して責務拡大が大きいため棄却した。

一方、completed-only rollout projectionとDB freshness照合の組合せは、進行中tailを除外しつつ既存Throughline本文を再利用できる。現時点でこの反対仮説を崩す証拠はない。独立subagent反証はユーザー許可が無いため実施していない。

## 根拠

- Throughline: `src/codex-capture.mjs`、`src/codex-rollout-memory.mjs`、`src/auditor-context.mjs`、`src/cli/codex-hook.mjs`、`src/turn-processor.mjs`
- Codex公式Hooks: https://learn.chatgpt.com/docs/hooks.md
- Codex 0.144.3 source: https://github.com/openai/codex/tree/rust-v0.144.3
  - MCP承認: `codex-rs/core/src/mcp_tool_call.rs`、`codex-rs/config/src/mcp_types.rs`
- dotagents実測: `/Users/kite/Developer/dotagents/rag/hooks/callout-hooks-firing-behavior.md`
- caveat: `codex-api-continuation-can-reach-task-complete-without-running-configured-stop-commands`
- caveat: `claude-code-stop-hook-assistant-15`（hostはClaudeだが、不可能条件をStop continuationへ積む無限loop構造をObserver設計へ適用）
