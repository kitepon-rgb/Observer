# ADR 0097: Observer MCPをread-only compatibility diagnosticsとして維持する

日付: 2026-07-16

## Status

Accepted for implementation。production Observer AIのtool surfaceは空のまま維持する。

## Context

ADR 0060はobservation cycleを外部Supervisorへ一意化し、Observer AIから`observer_read`／
`observer_wait`を除外した。一方、`observer-mcp` binary、read-only MCP server、package bin、
Claude runtimeのexact compatibility probeは残っている。Phase O2完了前に、この公開面を維持、deprecated、
削除のいずれへ進めるかを裁定する必要がある。

既存serverはactive watchのprovider／target／watch／projectをexact照合し、Throughline公開CLIのread／waitだけを
呼ぶ。Mailbox、state write、任意file、resource、prompt、sampling、taskを公開せず、
cancelとbounded stdioを持つ。
削除するとpackage bin、runtime probe、既存consumerを同時に壊すが、移行先と廃止期間は定義されていない。

## Decision

1. `observer-mcp`をdeprecatedまたは削除せず、read-only compatibility／diagnostics surfaceとして維持する。
   production cycle owner、Observer AI tool、Mailbox connector、一般project readerにはしない。
2. MCP toolは`observer_read`と`observer_wait`だけを維持する。liveな同一watch identityのexact照合後だけ
   Throughline公開clientを呼び、write API、fallback path、raw provider／state errorを追加しない。
3. production Observer AIの`--tools`／`--allowedTools`は空を維持する。Claude runtimeがMCP initialize／
   `tools/list`を行うのはpackage compatibility sentinelであり、AIへtoolを公開した証拠にはしない。
4. standalone binaryへ`--diagnostics`を追加し、次の決定的なsanitized JSON一件だけをstdoutへ返す。
   state、Throughline、network、credential、host processを読まず、stderrへ成功出力を混ぜない。

   ```json
   {
     "schema": "observer.mcp_diagnostics.v1",
     "status": "ready",
     "server_version": "0.0.0",
     "protocol_versions": ["2025-11-25", "2025-06-18"],
     "tools": ["observer_read", "observer_wait"],
     "production_ai_surface": "disabled"
   }
   ```

5. `--stdio`、`--version`、package `bin.observer-mcp`は互換維持する。未知引数はusage exit 2のままにする。
6. focused gateでdiagnostics exact JSON、active watch拒否、read/writeなし、cancel、
   stdout hygieneを固定する。
   live host登録、settings適用、credential、production AI呼出しは行わない。

## Rejected alternatives

- 削除: consumer移行、package major contract、Claude compatibility gateの置換が無く、独立revert可能なWaveにならない。
- deprecated: replacementが存在せず、警告だけを出すとinstallerとhost diagnosticsを不必要に不安定化する。
- production AIへ再公開: Supervisor単一所有を破り、同じcompleted turnの二重read／waitを再導入する。

## Consequences

- installerはhost AIを起動せず、`observer-mcp --diagnostics`でversioned surfaceを確認できる。
- MCP serverの存在とproduction AIのtool所有を区別できる。server greenをlive provider delivery成功へ読み替えない。
- 将来削除する場合はconsumer inventory、移行期間、package contract、rollbackを別のversioned Waveで扱う。
