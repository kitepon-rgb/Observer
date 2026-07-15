# ADR 0010: Claude background候補のread-only起動契約を固定する

日付: 2026-07-15

## Status

Claude Code 2.1.207のbackground jobを、Claude Observerの組込みtool surface候補として部分受入する。
`Read`／`Grep`／`Glob`だけを公開し、`dontAsk`、strictな空MCP構成で起動したjobは、project読取、
組込みwrite tool不在による一回の書込拒否、同じjob handleによる一覧・完了・terminal後stopを再現できた。
これはsettings／hooks／pluginsを含むCLI process全体のproject read-onlyをまだ証明しない。

Observer MCP限定write、65秒超のbackground継続、terminal receiptのdaemon非依存回収は未完のため、
production Observer hostとしてはまだ採用しない。

## Evidence

隔離した一時git repoをcwdにし、次の順序で起動した。

```text
claude --bg --name <name> --permission-mode dontAsk '<prompt>' \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  --tools 'Read,Grep,Glob'
```

実測結果:

1. 成功job `52eb5a00`はREADMEを読み、指定した確認文字列を返した。
2. 同jobにproject直下のsentinel作成を依頼したが、`Write` toolが無いため失敗した。
   親からの実ファイル確認でもsentinelは存在しなかった。
3. `agents --json`は同じjob IDとnameを`working`から`done`まで列挙した。
   terminal後の`claude stop 52eb5a00`は成功し、一覧上のterminal `done`を破壊しなかった。
   実行中jobの停止、子process消滅、再stopの冪等性は未実測である。
4. 先行job `200c4937`と`327b0365`はexit 1で失敗した。`--tools`と`--mcp-config`が
   可変長引数であり、後続flagまたはpromptを自分の値として取り込んだことが原因だった。
   成功試行では固定長flag、prompt positional、可変長flagの順に訂正した。
5. job実行中の`claude logs <id>`は取得できたが、terminal後に一時daemonが終了すると
   `control.sock`不在で同じ公開入口から回収できなかった。product-owned stateにはterminal結果が残るが、
   private state直読をproductionの公開契約にはしない。

## Decision

1. Claude親が明示指示を受けた時だけ、同じClaude Codeのbackground jobをClaude Observer候補として起動する。
2. `dontAsk`とexact tool allowlist `Read,Grep,Glob`を、`Bash`、`Write`、`Edit`をLLMへ公開しない候補として採用する。
   project read-only境界の強制とはまだ扱わず、prompt規律でも代用しない。
3. argv builderはprompt positionalを可変長の`--mcp-config`と`--tools`より前に置く。
   この順序をcontract testで固定する。
4. parent-launchのprivate provider handleはClaude job IDを保持する。terminal receiptのowner、作成時点、
   atomic保存、job ID／result digest相関、再開手順を別の耐久契約で固定するまで、`done`を結果回収済みへ昇格しない。
5. late `claude logs`だけに回収を依存させず、daemon不在を成功、未実行、空結果へ丸めない。
   private Claude stateの直読は標準fallbackにしない。
6. production採用前に、user／project／local settings、hooks、pluginsを隔離し、HEAD、index、tracked／untracked、
   modeを含む実行前後fingerprint不変を確認する。Observer MCP追加後もproject側fingerprint不変を再検証する。
7. 65秒超の実行中jobをstopし、`working → terminal`、子process残存なし、再stop、親／launcher再起動後の状態を確認する。
8. 即時完了、terminal直前のadapter crash、実行中adapter restart、daemon消失、失敗terminalでreceipt回収を検証する。
   公開入口だけで回収不能ならproduction候補はblockedのまま維持する。

## Consequences

- Claude Observerは同provider・同じAgent一覧でjob handleを追跡できる候補になった。
- Codex app-serverとはhandleと回収transportが異なるため、共通の文字列handleへ丸めない。
- terminal receiptの耐久プロトコルとprocess全体の非変更性が追加のadapter責務になる。
  後追いlogsと組込みtool allowlistだけでは境界を満たさない。
- 失敗した先行jobはcharacterization履歴として残し、成功へ書き換えない。
