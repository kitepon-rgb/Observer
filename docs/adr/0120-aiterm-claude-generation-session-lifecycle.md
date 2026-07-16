# ADR 0120: Aiterm Claude generation session lifecycle

日付: 2026-07-16

## Status

Accepted for implementation。ADR 0116のrollover／parent rebind未実装部分を具体化し、Aiterm公開境界は
0.14.0のstructured `pty_close` receiptへ更新する。

## Context

P5-1b4cまでのAiterm Claude launch requestとowner-only launch journalはtarget／watch単位だった。
この形のままgeneration rollover後に同じrequestを使うと、旧generationの`bound` launch receiptを
新generationのspawn／ready証拠として再利用できる。物理Claude TUIのcontextは初期化されず、
generation stateだけが進むため、Observer cognitionとdurable stateが乖離する。

また旧Aiterm 0.13.0の`pty_close`は人間向けtextだけで、MCP response loss後にclose済みか未実行かを
machine callerが区別できなかった。Aiterm側commit `056e0a4`は0.14.0で
`aiterm.pty-close-result.v1`の`closed | already_closed`を追加し、この欠落を製品所有repoで根治した。

## Decision

1. 一つのactive generationのcompleted cycleは、従来どおり同じ利用者可視Claude TUI sessionへ継続投入する。
   Throughline L2やSupervisor processをObserver cognitionの代替にしない。
2. planned rolloverとsame-provider parent rebindは、旧sessionをterminal確認してから別の物理Claude sessionを起動する。
   session名は既存target／watch prefixに、parent epochとgeneration sequenceから決定した12桁digest suffixを加える。
   同じtransitionの再実行は同じsession名、異なるgenerationは異なるsession名になる。
3. 初期generationの既存session名とlaunch journal pathは互換維持する。次generationのlaunch journalはsession instance別の
   pathへ分離し、旧`spawned`／`bound` receiptを別generationへ再利用できないようにする。
4. stopはAiterm `pty_close`だけを使い、structured `closed`／`already_closed`をexact検証する。
   同じsession IDへのretryだけでresponse lossを回収し、terminal host receiptとbounded close command receiptを
   host-neutral generation transactionへ耐久化してから新session startを認可する。
5. 新sessionはpromptless managed `claude_agent`で起動し、既存のlaunch-before-call journal、recover-only、
   structured spawn receiptを使う。spawn記録、watch handle CAS、ready記録、generation activationの順序は変更しない。
6. Supervisor runtimeは一つのAiterm MCP transportを所有し、activation完了後だけmutableなactive session handleを
   新generationへ移す。通常model cycleと最終cleanupはそのactive handleを参照する。
7. parent rebindは現行Codex runtimeと同じくsame-providerだけをこのwaveで扱う。Claude→Codex等のcross-providerを
   暗黙起動せず、明示unavailableのまま維持する。
8. SupervisorはAIではない。stop／delivery／exact-once／recovery／CAS／activation／Mailbox publishだけを制御し、
   modelとしてcompleted turnを読み続けたりL2を蓄積して理解したりしない。

## Rejected alternatives

- watch固定session名をclose後に再利用する案: handleとlaunch receiptのABAが起き、stale `bound`を新generationへ
  誤帰属できるため棄却。
- rollover時も同じClaude TUIを使い続け、generation stateだけ更新する案: context rolloverにならず、hard ceilingの
  意味を失うため棄却。
- `pty_close` textを解析する案:表示文言をmachine protocolへ昇格しresponse lossをexact回収できないため棄却。
- 旧`claude.background_agent`へ戻す案:利用者可視の永続Observer sessionとexact result契約を満たさないため棄却。
- Supervisor自身にcompleted turnを蓄積・理解させる案:Observer cognitionを非AI control processへ移す思想違反のため棄却。

## Acceptance

- Aiterm 0.14.0と`pty_close` output schemaをinitialize時に固定する。
- close初回／response-loss後retry、unique next session、stale old launch receipt拒否、spawn response recovery、
  watch handle CAS、ready／generation activation、same-provider parent rebind、active handle切替、cleanupをfake MCPで固定する。
- focused／related gate、`npm run check`、P5-1b4 Phase full regression、独立重監査を頻度規約どおり各一度だけ行う。
- 実Claude request、login、credential、publish、push、端末更新はP5-1b5 Hまで行わない。

## Rollback

P5-1b4dの独立commitをrevertし、0.14.0 transport追従、generation固有session名、Aiterm Claude
rollover／rebind adapter、runtime active handle切替、fixture、受入ADRを除去する。P5-1b4cまでの通常cycle、
Aiterm側0.14.0 commit、Codex lifecycle、旧blocked background characterizationは維持する。
