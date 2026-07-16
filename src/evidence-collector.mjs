import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { buildEvidenceSnapshot } from "./evidence-snapshot.mjs";
import { fail } from "./observer-error.mjs";

const execFileAsync = promisify(execFile);

export const EVIDENCE_COLLECTOR_SOURCE_MAX_BYTES = 1024 * 1024;
export const EVIDENCE_COLLECTOR_GIT_TIMEOUT_MS = 5_000;

const REQUEST_KEYS = Object.freeze(["context", "plan_refs", "project_root", "test_receipts", "turns"]);
const DEPENDENCY_KEYS = Object.freeze(["fs", "runGit"]);
const FILESYSTEM_KEYS = Object.freeze(["readFile", "realpath", "stat"]);
const TEST_RECEIPT_KEYS = Object.freeze([
  "available",
  "command_ref",
  "observed_at",
  "outcome",
  "ref",
  "source_digest",
  "unavailable_code",
]);
const PLAN_REF_PREFIX = "file:";
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const GIT_SOURCES = Object.freeze([
  { ref: "git:head", args: ["rev-parse", "HEAD"] },
  { ref: "git:status", args: ["status", "--porcelain=v1", "--branch"] },
  { ref: "git:unstaged_diff", args: ["diff", "--no-ext-diff", "--no-textconv"] },
  { ref: "git:staged_diff", args: ["diff", "--cached", "--no-ext-diff", "--no-textconv"] },
]);
const GIT_ENV = Object.freeze({
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_EXTERNAL_DIFF: "",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  LC_ALL: "C",
  PAGER: "cat",
});
const defaultRunGit = createDefaultGitRunner(execFileAsync);

/**
 * Collects builder input without writing to the project, git, or Observer state.
 * @param {object} request trusted context, completed turns, approved refs, receipts and root
 * @param {object} [dependencies] test-only filesystem and git seams
 */
export async function collectEvidenceInput(request, dependencies = undefined) {
  validateRequest(request);
  const dependenciesResolved = resolveDependencies(dependencies);
  const projectRoot = await canonicalProjectRoot(request.project_root, dependenciesResolved.fs);
  const plan = await Promise.all(request.plan_refs.map((ref) => collectPlan(ref, projectRoot, dependenciesResolved.fs)));
  const git = await Promise.all(GIT_SOURCES.map((source) => collectGit(source, projectRoot, dependenciesResolved.runGit)));

  return {
    context: structuredClone(request.context),
    turns: request.turns.map(normalizeCompletedTurn),
    plan,
    git,
    tests: request.test_receipts.map((receipt) => structuredClone(receipt)),
  };
}

function normalizeCompletedTurn(value) {
  requirePlainObject(value, "turn");
  if (!Number.isSafeInteger(value.completed_at) || value.completed_at < 0) {
    invalid("turn.completed_atは非負のepoch milliseconds整数である必要があります");
  }
  let completedAt;
  try {
    completedAt = new Date(value.completed_at).toISOString();
  } catch {
    invalid("turn.completed_atをcanonical timestampへ変換できません");
  }
  if (!CANONICAL_TIMESTAMP.test(completedAt) || Date.parse(completedAt) !== value.completed_at) {
    invalid("turn.completed_atをcanonical timestampへ変換できません");
  }
  return { ...structuredClone(value), completed_at: completedAt };
}

export async function collectEvidenceSnapshot(request, dependencies = undefined) {
  return buildEvidenceSnapshot(await collectEvidenceInput(request, dependencies));
}

function validateRequest(request) {
  requirePlainObject(request, "request");
  requireExactKeys(request, REQUEST_KEYS, "request");
  if (typeof request.project_root !== "string" || !path.isAbsolute(request.project_root)) invalid("request.project_rootはabsolute pathである必要があります");
  requireDenseArray(request.turns, "request.turns");
  requireDenseArray(request.plan_refs, "request.plan_refs");
  requireDenseArray(request.test_receipts, "request.test_receipts");
  for (const ref of request.plan_refs) validatePlanRef(ref);
  for (const receipt of request.test_receipts) validateTestReceipt(receipt);
}

function resolveDependencies(dependencies) {
  if (dependencies === undefined) {
    return {
      fs: { readFile, realpath, stat },
      runGit: defaultRunGit,
    };
  }
  requirePlainObject(dependencies, "dependencies");
  requireExactKeys(dependencies, DEPENDENCY_KEYS, "dependencies");
  requirePlainObject(dependencies.fs, "dependencies.fs");
  requireExactKeys(dependencies.fs, FILESYSTEM_KEYS, "dependencies.fs");
  for (const name of FILESYSTEM_KEYS) {
    if (typeof dependencies.fs[name] !== "function") invalid(`dependencies.fs.${name}はfunctionである必要があります`);
  }
  if (typeof dependencies.runGit !== "function") invalid("dependencies.runGitはfunctionである必要があります");
  return dependencies;
}

async function canonicalProjectRoot(projectRoot, fs) {
  try {
    const root = await fs.realpath(projectRoot);
    const rootStat = await fs.stat(root);
    if (!rootStat.isDirectory()) invalid("request.project_rootはdirectoryである必要があります");
    return root;
  } catch (error) {
    if (error?.code === "E_EVIDENCE_COLLECTOR_INVALID") throw error;
    invalid("request.project_rootをcanonical directoryへ解決できません");
  }
}

async function collectPlan(ref, projectRoot, fs) {
  const unavailable = (code) => unavailableContent("plan", ref, code);
  const relativePath = ref.slice(PLAN_REF_PREFIX.length);
  const lexicalPath = path.resolve(projectRoot, relativePath);
  if (!isInside(projectRoot, lexicalPath)) return unavailable("PLAN_OUTSIDE_PROJECT");

  let canonicalPath;
  try {
    canonicalPath = await fs.realpath(lexicalPath);
  } catch {
    return unavailable("PLAN_NOT_FOUND");
  }
  if (!isInside(projectRoot, canonicalPath)) return unavailable("PLAN_OUTSIDE_PROJECT");

  try {
    const fileStat = await fs.stat(canonicalPath);
    if (!fileStat.isFile()) return unavailable("PLAN_NOT_REGULAR_FILE");
    if (!Number.isSafeInteger(fileStat.size) || fileStat.size < 0 || fileStat.size > EVIDENCE_COLLECTOR_SOURCE_MAX_BYTES) {
      return unavailable("PLAN_TOO_LARGE");
    }
    const bytes = await fs.readFile(canonicalPath);
    if (!Buffer.isBuffer(bytes) || bytes.byteLength > EVIDENCE_COLLECTOR_SOURCE_MAX_BYTES) return unavailable("PLAN_TOO_LARGE");
    const content = decodeUtf8(bytes);
    return availableContent("plan", ref, content);
  } catch (error) {
    if (error?.code === "ERR_INVALID_ARG_TYPE") return unavailable("PLAN_READ_FAILED");
    if (error?.code === "E_EVIDENCE_COLLECTOR_NON_UTF8") return unavailable("PLAN_NON_UTF8");
    return unavailable("PLAN_READ_FAILED");
  }
}

async function collectGit(source, projectRoot, runGit) {
  try {
    const result = await runGit({ cwd: projectRoot, args: source.args });
    requirePlainObject(result, "git result");
    requireExactKeys(result, ["stderr", "stdout"], "git result");
    const stdout = asBoundedBuffer(result.stdout, "GIT_OUTPUT_TOO_LARGE");
    asBoundedBuffer(result.stderr, "GIT_OUTPUT_TOO_LARGE");
    return availableContent("git", source.ref, decodeUtf8(stdout));
  } catch (error) {
    const code = error?.code === "E_EVIDENCE_COLLECTOR_NON_UTF8"
      ? "GIT_NON_UTF8"
      : error?.code === "E_EVIDENCE_COLLECTOR_GIT_OUTPUT_TOO_LARGE"
        ? "GIT_OUTPUT_TOO_LARGE"
        : "GIT_COMMAND_FAILED";
    return unavailableContent("git", source.ref, code);
  }
}

export function createDefaultGitRunner(execute) {
  if (typeof execute !== "function") invalid("git executorはfunctionである必要があります");
  return async ({ cwd, args }) => {
  try {
    const result = await execute("git", [
      "--no-optional-locks",
      "-c", "core.pager=cat",
      "-c", "pager.diff=false",
      "-c", "diff.external=",
      "-c", "core.fsmonitor=false",
      "-c", "core.untrackedCache=false",
      ...args,
    ], {
      cwd,
      encoding: "buffer",
      env: { ...GIT_ENV, PATH: process.env.PATH ?? "/usr/bin:/bin" },
      maxBuffer: EVIDENCE_COLLECTOR_SOURCE_MAX_BYTES + 1,
      shell: false,
      timeout: EVIDENCE_COLLECTOR_GIT_TIMEOUT_MS,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") outputTooLarge();
    if (Buffer.isBuffer(error?.stdout) && error.stdout.byteLength > EVIDENCE_COLLECTOR_SOURCE_MAX_BYTES) outputTooLarge();
    if (Buffer.isBuffer(error?.stderr) && error.stderr.byteLength > EVIDENCE_COLLECTOR_SOURCE_MAX_BYTES) outputTooLarge();
    throw error;
  }
  };
}

function availableContent(section, ref, content) {
  return {
    ref,
    source_digest: sourceDigest(section, ref, content),
    available: true,
    content,
    unavailable_code: null,
  };
}

function unavailableContent(section, ref, code) {
  return {
    ref,
    source_digest: sourceDigest(section, ref, `unavailable:${code}`),
    available: false,
    content: null,
    unavailable_code: code,
  };
}

function sourceDigest(section, ref, content) {
  return `sha256:${createHash("sha256")
    .update("observer.evidence-source.v1\0", "utf8")
    .update(section, "utf8")
    .update("\0", "utf8")
    .update(ref, "utf8")
    .update("\0", "utf8")
    .update(content, "utf8")
    .digest("hex")}`;
}

function asBoundedBuffer(value, overflowCode) {
  const buffer = Buffer.isBuffer(value) ? value : typeof value === "string" ? Buffer.from(value, "utf8") : null;
  if (buffer === null) invalid("git resultのstdout/stderrはBufferまたはstringである必要があります");
  if (buffer.byteLength > EVIDENCE_COLLECTOR_SOURCE_MAX_BYTES) {
    if (overflowCode === "GIT_OUTPUT_TOO_LARGE") outputTooLarge();
    invalid("sourceがbyte上限を超えています");
  }
  return buffer;
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const error = new Error("non-UTF-8 source");
    error.code = "E_EVIDENCE_COLLECTOR_NON_UTF8";
    throw error;
  }
}

function outputTooLarge() {
  const error = new Error("git output exceeds the collector limit");
  error.code = "E_EVIDENCE_COLLECTOR_GIT_OUTPUT_TOO_LARGE";
  throw error;
}

function validatePlanRef(ref) {
  if (typeof ref !== "string" || !ref.startsWith(PLAN_REF_PREFIX)) invalid("plan refはfile:形式である必要があります");
  const relativePath = ref.slice(PLAN_REF_PREFIX.length);
  if (relativePath.length === 0 || relativePath.includes("\\") || relativePath.startsWith("/") || /^[A-Za-z]:/.test(relativePath)) {
    invalid("plan refはproject-relative pathである必要があります");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) invalid("plan refにpath traversalを使用できません");
}

function validateTestReceipt(receipt) {
  requirePlainObject(receipt, "test receipt");
  requireExactKeys(receipt, TEST_RECEIPT_KEYS, "test receipt");
  if (typeof receipt.ref !== "string" || !/^test:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(receipt.ref)) invalid("test receipt.refが不正です");
  if (typeof receipt.source_digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(receipt.source_digest)) invalid("test receipt.source_digestが不正です");
  if (typeof receipt.available !== "boolean") invalid("test receipt.availableが不正です");
  if (receipt.available) {
    if (typeof receipt.command_ref !== "string" || !["passed", "failed", "skipped"].includes(receipt.outcome)
      || !isCanonicalTimestamp(receipt.observed_at) || receipt.unavailable_code !== null) invalid("available test receiptのavailability matrixが不正です");
  } else if (receipt.command_ref !== null || receipt.outcome !== "unavailable" || receipt.observed_at !== null
    || typeof receipt.unavailable_code !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(receipt.unavailable_code)) {
    invalid("unavailable test receiptのavailability matrixが不正です");
  }
}

function isCanonicalTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function requireDenseArray(value, field) {
  if (!Array.isArray(value)) invalid(`${field}はdense arrayである必要があります`);
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) invalid(`${field}はdense arrayである必要があります`);
  }
}

function requirePlainObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length > 0) invalid(`${field}はplain objectである必要があります`);
}

function requireExactKeys(value, expected, field) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) invalid(`${field}に未知または不足fieldがあります`);
}

function invalid(message) {
  fail("E_EVIDENCE_COLLECTOR_INVALID", message);
}
