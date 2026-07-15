#!/usr/bin/env node

import { OBSERVER_MCP_SERVER_VERSION, runObserverMcpStdio } from "../src/mcp-server.mjs";

const args = process.argv.slice(2);

if (args.length === 1 && args[0] === "--version") {
  process.stdout.write(`${OBSERVER_MCP_SERVER_VERSION}\n`);
} else if (args.length === 1 && args[0] === "--stdio") {
  try {
    runObserverMcpStdio();
  } catch {
    process.stderr.write("Observer MCP failed to initialize\n");
    process.exitCode = 1;
  }
} else {
  process.stderr.write("usage: observer-mcp --stdio | --version\n");
  process.exitCode = 2;
}
