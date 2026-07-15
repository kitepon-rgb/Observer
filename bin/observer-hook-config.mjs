#!/usr/bin/env node
import { TextDecoder } from "node:util";

import {
  buildParentStopHookFragment,
  verifyParentStopHookConfig,
} from "../src/parent-stop-hook-config.mjs";
import { ObserverError } from "../src/observer-error.mjs";

const MAX_CANDIDATE_BYTES = 1024 * 1024;
const USAGE = "usage: observer-hook-config <fragment|verify> --provider <claude|codex> --executable <absolute-path>";

function usageError(message = USAGE) {
  const error = new Error(message);
  error.code = "E_USAGE";
  return error;
}

function parseFlags(args) {
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== "--provider" && flag !== "--executable") throw usageError();
    if (flags[flag] !== undefined || index + 1 >= args.length) throw usageError();
    flags[flag] = args[index + 1];
    index += 1;
  }
  if (flags["--provider"] === undefined || flags["--executable"] === undefined) throw usageError();
  return { provider: flags["--provider"], executablePath: flags["--executable"] };
}

async function readCandidate() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_CANDIDATE_BYTES) throw new ObserverError("E_PARENT_STOP_HOOK_CANDIDATE_TOO_LARGE", "hook candidate JSONが上限を超えました");
    chunks.push(buffer);
  }
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new ObserverError("E_PARENT_STOP_HOOK_CANDIDATE_UTF8_INVALID", "hook candidate JSONがUTF-8ではありません");
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new ObserverError("E_PARENT_STOP_HOOK_CANDIDATE_JSON_INVALID", "hook candidate JSONを解析できません");
  }
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  const [operation, ...args] = process.argv.slice(2);
  if (operation !== "fragment" && operation !== "verify") throw usageError();
  const options = parseFlags(args);
  if (operation === "fragment") return buildParentStopHookFragment(options);
  return verifyParentStopHookConfig({ ...options, candidate: await readCandidate() });
}

try {
  writeJson(process.stdout, await main());
} catch (error) {
  if (error?.code === "E_USAGE") {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  } else {
    writeJson(process.stderr, {
      error: {
        code: typeof error?.code === "string" ? error.code : "E_INTERNAL",
        message: error instanceof Error ? error.message : "内部エラーです",
      },
    });
    process.exitCode = 1;
  }
}
