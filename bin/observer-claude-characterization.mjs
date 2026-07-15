#!/usr/bin/env node

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify, TextDecoder } from "node:util";

import {
  captureClaudeCharacterizationStopInput,
  cleanupClaudeCharacterization,
  inspectClaudeCharacterizationReadiness,
  prepareClaudeCharacterization,
  verifyClaudeCharacterization,
} from "../src/claude-characterization.mjs";
import { ObserverError } from "../src/observer-error.mjs";

const executeFile = promisify(execFile);
const SELF = fileURLToPath(import.meta.url);
const STDIN_LIMIT = 1024 * 1024;
const USAGE = [
  "usage: observer-claude-characterization readiness --claude-command <absolute-path>",
  "       observer-claude-characterization prepare --work-root <absolute-path> --expected-cwd <absolute-path> [--campaign-id <sha256>]",
  "       observer-claude-characterization hook --campaign-id <sha256> --capture-path <absolute-path> --hook-receipt-path <absolute-path> --expected-cwd <absolute-path>",
  "       observer-claude-characterization verify --campaign-id <sha256> --capture-path <absolute-path> --hook-receipt-path <absolute-path>",
  "       observer-claude-characterization cleanup --work-root <absolute-path> --campaign-id <sha256>",
].join("\n");

function usageError() {
  const error = new Error(USAGE);
  error.code = "E_USAGE";
  return error;
}

function flags(args, allowed, required) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!allowed.has(name) || Object.hasOwn(result, name) || index + 1 >= args.length) throw usageError();
    result[name] = args[index + 1];
    index += 1;
  }
  if (required.some((name) => !Object.hasOwn(result, name))) throw usageError();
  return result;
}

async function readStdinBytes({ classifyLimit = false } = {}) {
  const chunks = [];
  let length = 0;
  let exceeded = false;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > STDIN_LIMIT) {
      if (classifyLimit) {
        exceeded = true;
        chunks.length = 0;
        continue;
      }
      const error = new Error("stdinが上限を超えました");
      error.code = "E_STDIN_LIMIT";
      throw error;
    }
    if (!exceeded) chunks.push(buffer);
  }
  return {
    bytes: exceeded ? null : Buffer.concat(chunks),
    failureCode: exceeded ? "E_CLAUDE_CHARACTERIZATION_STOP_STDIN_LIMIT" : null,
  };
}

async function readStdinText() {
  const { bytes } = await readStdinBytes();
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const error = new Error("stdinがUTF-8ではありません");
    error.code = "E_STDIN_INVALID";
    throw error;
  }
  return source;
}

async function readStdinJson() {
  try {
    return JSON.parse(await readStdinText());
  } catch (error) {
    if (error?.code === "E_STDIN_LIMIT" || error?.code === "E_STDIN_INVALID") throw error;
    const invalid = new Error("stdinがJSONではありません");
    invalid.code = "E_STDIN_INVALID";
    throw invalid;
  }
}

async function readiness(args) {
  const options = flags(args, new Set(["--claude-command"]), ["--claude-command"]);
  const command = options["--claude-command"];
  const common = { encoding: "utf8", maxBuffer: STDIN_LIMIT };
  const [version, root, agents] = await Promise.all([
    executeFile(command, ["--version"], common),
    executeFile(command, ["--help"], common),
    executeFile(command, ["agents", "--help"], common),
  ]);
  return inspectClaudeCharacterizationReadiness({
    versionStdout: version.stdout,
    rootHelp: root.stdout,
    agentsHelp: agents.stdout,
  });
}

async function main() {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === "readiness") return { output: await readiness(args) };
  if (operation === "prepare") {
    const options = flags(
      args,
      new Set(["--work-root", "--expected-cwd", "--campaign-id"]),
      ["--work-root", "--expected-cwd"],
    );
    return {
      output: await prepareClaudeCharacterization({
        workRoot: options["--work-root"],
        expectedCwd: options["--expected-cwd"],
        campaignId: options["--campaign-id"],
        hookExecutable: SELF,
      }),
    };
  }
  if (operation === "hook") {
    const options = flags(
      args,
      new Set(["--campaign-id", "--capture-path", "--hook-receipt-path", "--expected-cwd"]),
      ["--campaign-id", "--capture-path", "--hook-receipt-path", "--expected-cwd"],
    );
    const hookInput = await readStdinBytes({ classifyLimit: true });
    await captureClaudeCharacterizationStopInput({
      campaignId: options["--campaign-id"],
      capturePath: options["--capture-path"],
      hookReceiptPath: options["--hook-receipt-path"],
      expectedCwd: options["--expected-cwd"],
      stdin: hookInput.bytes,
      stdinFailureCode: hookInput.failureCode,
    });
    return { output: null };
  }
  if (operation === "verify") {
    const options = flags(
      args,
      new Set(["--campaign-id", "--capture-path", "--hook-receipt-path"]),
      ["--campaign-id", "--capture-path", "--hook-receipt-path"],
    );
    const input = await readStdinJson();
    return {
      output: await verifyClaudeCharacterization({
        campaignId: options["--campaign-id"],
        capturePath: options["--capture-path"],
        hookReceiptPath: options["--hook-receipt-path"],
        agentsStdout: JSON.stringify(input.agents),
        expected: input.expected,
        replySurface: input.reply_surface,
        terminalResult: input.terminal_result ?? null,
      }),
    };
  }
  if (operation === "cleanup") {
    const options = flags(
      args,
      new Set(["--work-root", "--campaign-id"]),
      ["--work-root", "--campaign-id"],
    );
    return {
      output: await cleanupClaudeCharacterization({
        workRoot: options["--work-root"],
        campaignId: options["--campaign-id"],
      }),
    };
  }
  throw usageError();
}

try {
  const result = await main();
  if (result.output !== null) process.stdout.write(`${JSON.stringify(result.output)}\n`);
} catch (error) {
  const code = typeof error?.code === "string" ? error.code : "E_INTERNAL";
  const message = error instanceof ObserverError || code !== "E_INTERNAL"
    ? error.message
    : "Claude characterization commandが失敗しました";
  process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
  process.exitCode = code === "E_USAGE" ? 2 : 1;
}
