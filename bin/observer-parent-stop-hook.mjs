#!/usr/bin/env node

import { isAbsolute } from "node:path";

import { ObserverError, fail } from "../src/observer-error.mjs";
import { runParentStopHook } from "../src/parent-stop-hook.mjs";
import { defaultStateRoot } from "../src/private-state.mjs";

const STDIN_MAX_BYTES = 1024 * 1024;

function usage() {
  return "usage: observer-parent-stop-hook --provider <claude|codex> [--state-root <absolute-path>]";
}

function parseArguments(argv) {
  let provider;
  let stateRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) fail("E_USAGE", usage());
    if (flag === "--provider" && provider === undefined) provider = value;
    else if (flag === "--state-root" && stateRoot === undefined) stateRoot = value;
    else fail("E_USAGE", usage());
    index += 1;
  }
  if (!new Set(["claude", "codex"]).has(provider)) fail("E_USAGE", usage());
  if (stateRoot !== undefined && !isAbsolute(stateRoot)) fail("E_USAGE", usage());
  return { provider, stateRoot: stateRoot ?? defaultStateRoot() };
}

async function readPayload() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > STDIN_MAX_BYTES) fail("E_PARENT_STOP_STDIN_LIMIT", "parent Stop payloadが上限を超えました");
    chunks.push(chunk);
  }
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    fail("E_PARENT_STOP_STDIN_INVALID", "parent Stop payloadがUTF-8ではありません");
  }
  try {
    return JSON.parse(decoded);
  } catch {
    fail("E_PARENT_STOP_STDIN_INVALID", "parent Stop payloadがJSONではありません");
  }
}

function emitHookOutput(serialized) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      process.stdout.off("error", onError);
      reject(error);
    };
    process.stdout.once("error", onError);
    process.stdout.write(serialized, () => {
      process.stdout.off("error", onError);
      resolve();
    });
  });
}

try {
  const args = parseArguments(process.argv.slice(2));
  const payload = await readPayload();
  await runParentStopHook({ ...args, payload }, { emitHookOutput });
} catch (error) {
  const code = error instanceof ObserverError ? error.code : "E_INTERNAL";
  process.stderr.write(`Observer parent Stop hook failed: ${code}\n`);
  process.exitCode = code === "E_USAGE" ? 2 : 1;
}
