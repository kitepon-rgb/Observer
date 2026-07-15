# ADR 0013: Expose completed-turn read and wait through a bounded stdio MCP server

Date: 2026-07-15

## Status

Accepted

## Context

Observer children must use Throughline's public `observer-read` and `observer-wait` CLI without importing Throughline code or reading its DB. The Claude host adapter already constrains its MCP process to an absolute executable below the Observer runtime root and exposes only `mcp__observer__*` tools. The executable and MCP wire itself are not yet implemented.

The MCP 2025-11-25 specification defines stdio as newline-delimited UTF-8 JSON-RPC 2.0, reserves stdout for protocol messages, requires initialization before normal operation, and permits structured tool results alongside a JSON text block. Its task-augmented request support is experimental and is not needed for an ordinary long-lived `tools/call`.

An MCP annotation is only a hint. Project isolation must therefore come from Observer's durable active-watch state, not from `readOnlyHint` or from trusting tool arguments supplied by the model.

## Decision

Observer will ship a dependency-free stdio MCP server with these boundaries:

- The executable accepts exactly `bin/observer-mcp.mjs --stdio` for protocol operation and `--version` for executable verification. Stdio operation writes protocol messages only to stdout and bounded diagnostics only to stderr.
- The server accepts newline-delimited JSON-RPC 2.0 with a 64 KiB maximum input message. Batch messages, duplicate active request IDs, non-finite IDs, unknown lifecycle transitions, and malformed messages fail closed with a protocol error or process failure as appropriate.
- The first request is `initialize`. The server supports MCP revisions `2025-11-25` and `2025-06-18`, echoes a supported requested revision, otherwise offers its latest revision, and declares only `tools: { listChanged: false }`. `notifications/initialized` opens normal operation. `ping` remains available as the lifecycle exception.
- The fixed tool surface is `observer_read` and `observer_wait`. Tools do not support task augmentation. Both publish exact JSON Schema, `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, and `openWorldHint: false`.
- Both tools require the child start identity on every call: `provider`, `target_id`, `watch_id`, and canonical `project_root`. Before Throughline is invoked, the server reads Observer-owned active-watch state and requires an exact identity match in `launching` or `active`. A model cannot widen the project by changing arguments.
- `observer_read` forwards only the validated cursor, fixed-through pagination, and limit fields to `createThroughlineClient().read`. `observer_wait` forwards only the validated after cursor, timeout, and a request-scoped AbortSignal to `.wait`.
- `notifications/cancelled` aborts the matching pending call. stdin shutdown aborts all pending calls. Request IDs are removed only after exactly one terminal response is emitted.
- Successful tools return the same bounded Throughline wire in both `structuredContent` and a serialized JSON text content block. Known Observer/Throughline failures return a bounded `{ schema, status: "error", code, message }` tool result with `isError: true`; raw stderr, paths other than the already-authorized project field, bodies, cursors, hashes, and stack traces are never copied into an error.
- Unknown tools and structurally invalid arguments are JSON-RPC protocol errors. A valid tool whose execution fails uses a tool error result, as required by the MCP tool contract.
- The MCP server does not expose target registration, watch start/stop, Mailbox publish, arbitrary file access, resources, prompts, sampling, roots, logging, or experimental MCP tasks. Start and stop remain parent-owned and require the user's explicit instruction.

## Consequences

- Claude and future Codex host adapters receive one stable executable and can verify its realpath, ownership, mode, version, and tool list before launching a child.
- Long waits remain ordinary cancellable tool calls and reuse the existing Throughline subprocess cleanup contract.
- The MCP process reads Observer's private watch state but does not mutate it. `launching` is accepted so the newly spawned child can begin after the parent has durably stored the provider handle but before the parent marks it ready.
- Mailbox publish will require a separate tool and permission decision; it cannot be smuggled into this read/wait surface.
- Compatibility with a real Claude MCP client, including negotiated version and 65-second call retention, remains a host characterization gate after this server's protocol fixture is green.
