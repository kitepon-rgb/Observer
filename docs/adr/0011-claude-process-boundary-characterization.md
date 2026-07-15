# ADR 0011: Claude background process境界と実行中stopを部分受入する

日付: 2026-07-15

## Status

Claude Code 2.1.210のbackground jobで、設定源を無効化したproject非変更fixtureと、
60秒超の実行中stopを部分受入する。Observer MCP write、親／launcher再起動、daemon／adapter crash後の
terminal result receipt、再stopの冪等成功は未完のため、Claude live adapterのproduction採用はblockedのまま維持する。

## Profile

隔離した一時git repoで次を指定した。

- `--permission-mode dontAsk`
- `--setting-sources ""`
- `--disable-slash-commands`
- `--no-chrome`
- `--strict-mcp-config`とcharacterization専用timer MCP一件
- `--tools Read,Grep,Glob,mcp__timer__wait`
- `--allowedTools mcp__timer__wait`

timer MCPはproject fileを変更せず、90秒待つread-only toolだけを公開した。

## Evidence

1. 先行job `aedabbc8`はtimer toolを`--tools`で公開したが、`--allowedTools`に入れなかったため、
   `dontAsk`がtool callを拒否した。jobは`blocked`となり、成功へ丸めず明示stopで`stopped`へ閉じた。
2. 訂正job `27a07708`は起動直後、55秒、75秒の公開`agents --json`観測で一貫して
   `status=busy`、`state=working`だった。
3. 90秒timerが返る前の起動80秒時点で`claude stop 27a07708`を実行し、CLIは`stopped`を返した。
   直後の公開一覧は`state=stopped`、timer MCP子processは残存しなかった。
4. 同じjobへの再stopは成功receiptを返さず、background service再起動の可能性により確認不能と報告した。
   公開一覧は`stopped`を保持した。stop command自体を冪等成功とは扱わない。
5. 実行前後で、HEAD、index digest、tracked blob／mode、tracked file digest、status、project内file集合が一致した。
   untracked fileは作られず、characterization対象repoのfingerprintは不変だった。

## Decision

1. `--tools`はtool公開、`--allowedTools`は`dontAsk`下の無人許可として別々にexact指定する。
   Observer MCP toolも公開と許可の両方へ対象tool単位で入れる。
2. project非変更profileは、空のsetting sources、skills無効、Chrome無効、strict MCP、exact tool surfaceを
   一体で構成する。組込みtool allowlist単独をprocess境界の証拠にしない。
3. stop adapterは、公開一覧で既にterminalならCLI stopを再発行せず`already_terminal`を返す。
   実行中stopのcommand receiptと、その後のterminal state観測を別々に保存する。
4. stop commandが確認不能なら成功へ丸めず、同じjob IDを公開一覧で再観測する。
   terminalが確認できなければ`stopping`を維持する。
5. production前にObserver MCP限定writeとproject fingerprint不変を同時に再検証し、親／launcher再起動、
   即時完了、terminal直前のadapter crash、実行中adapter restart、daemon消失、失敗terminalのreceiptを閉じる。

## Consequences

- Claude backgroundが60秒超のtool call中でも公開jobとして生存し、明示stopで子processまで停止できることを確認した。
- CLI stopを何度呼んでも成功する、という冪等性はない。Observer adapterがterminal stateを先に扱う必要がある。
- 一件の隔離fixtureだけで一般的なproject非変更性を証明したとは扱わず、Observer MCP統合後の回帰gateを残す。
