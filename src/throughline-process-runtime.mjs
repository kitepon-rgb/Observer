import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";

import { fail } from "./observer-error.mjs";
import { createThroughlineClient } from "./throughline-client.mjs";

export const THROUGHLINE_PROCESS_VERIFICATION_SCHEMA = "observer.throughline_process_verification.v1";
export const SUPPORTED_THROUGHLINE_VERSION = "0.6.3";

const VERSION_TIMEOUT_MS = 5_000;
const MAX_VERSION_BYTES = 64 * 1024;
const ENV_ALLOWLIST = Object.freeze([
  "HOME", "LANG", "LC_ALL", "PATH", "SHELL", "TMPDIR", "USER", "USERPROFILE",
  "XDG_CONFIG_HOME", "XDG_STATE_HOME",
]);

export async function verifyThroughlineRuntime({ runtimeRoot, throughlineCommand } = {}, dependencies = {}) {
  const canonicalRoot = await canonicalRuntimeRoot(runtimeRoot, dependencies);
  const effectiveUid = dependencies.effectiveUid ?? (typeof process.getuid === "function" ? process.getuid() : null);
  if (!Number.isInteger(effectiveUid)) fail("E_THROUGHLINE_RUNTIME_OWNER_UNAVAILABLE", "effective UIDを確認できません");
  const inspect = dependencies.inspectExecutable ?? inspectExecutable;
  const throughline = await inspect({ candidate: throughlineCommand, effectiveUid }, dependencies);
  await recheckExecutableIdentity(throughline, dependencies);
  const run = dependencies.runFile ?? runFile;
  const version = await run(throughline.realpath, ["--version"], commandOptions(canonicalRoot), dependencies);
  if (version.exit_code !== 0 || version.stdout.trim() !== SUPPORTED_THROUGHLINE_VERSION || version.stderr !== "") {
    fail("E_THROUGHLINE_VERSION_UNSUPPORTED", "Throughline versionが固定契約と一致しません");
  }
  await recheckExecutableIdentity(throughline, dependencies);
  return {
    schema: THROUGHLINE_PROCESS_VERIFICATION_SCHEMA,
    runtime_root: canonicalRoot,
    throughline: { ...throughline, version: SUPPORTED_THROUGHLINE_VERSION },
  };
}

export function createVerifiedThroughlineClient({ verification } = {}, dependencies = {}) {
  validateVerification(verification);
  const createClient = dependencies.createThroughlineClient ?? createThroughlineClient;
  const client = createClient({ command: verification.throughline.realpath });
  if (!client || typeof client.read !== "function" || typeof client.wait !== "function") {
    fail("E_THROUGHLINE_VERIFIED_CLIENT_INVALID", "verified Throughline clientを生成できません");
  }
  return {
    async read(input) {
      await recheckExecutableIdentity(verification.throughline, dependencies);
      return client.read(input);
    },
    async wait(input) {
      await recheckExecutableIdentity(verification.throughline, dependencies);
      return client.wait(input);
    },
  };
}

async function canonicalRuntimeRoot(value, dependencies) {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || hasControl(value)) {
    fail("E_THROUGHLINE_RUNTIME_ROOT_INVALID", "Observer runtime rootが不正です");
  }
  const canonical = await (dependencies.realpath ?? realpath)(value);
  if (canonical !== value) fail("E_THROUGHLINE_RUNTIME_ROOT_INVALID", "Observer runtime rootはcanonical pathである必要があります");
  return canonical;
}

async function inspectExecutable({ candidate, effectiveUid }, dependencies) {
  if (typeof candidate !== "string" || !isAbsolute(candidate) || normalize(candidate) !== candidate || hasControl(candidate)) {
    fail("E_THROUGHLINE_RUNTIME_EXECUTABLE_INVALID", "Throughline executable pathが不正です");
  }
  const canonical = await (dependencies.realpath ?? realpath)(candidate);
  await verifyAncestors(canonical, effectiveUid, dependencies);
  const handle = await (dependencies.open ?? open)(canonical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || (info.mode & 0o111n) === 0n || (info.mode & 0o022n) !== 0n || ![0, effectiveUid].includes(Number(info.uid))) {
      fail("E_THROUGHLINE_RUNTIME_EXECUTABLE_INVALID", "Throughline executableのownerまたはmodeが不正です");
    }
    await (dependencies.access ?? access)(canonical, fsConstants.X_OK);
    return {
      candidate,
      realpath: canonical,
      uid: Number(info.uid),
      gid: Number(info.gid),
      mode: Number(info.mode & 0o7777n),
      dev: info.dev.toString(),
      ino: info.ino.toString(),
      size: info.size.toString(),
      mtime_ns: info.mtimeNs.toString(),
      digest: await digestOpenFile(handle),
    };
  } finally {
    await handle.close();
  }
}

async function verifyAncestors(actual, effectiveUid, dependencies) {
  let current = dirname(actual);
  while (true) {
    const info = await (dependencies.lstat ?? lstat)(current, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o002n) !== 0n || ![0, effectiveUid].includes(Number(info.uid))) {
      fail("E_THROUGHLINE_RUNTIME_ANCESTOR_INVALID", "Throughline executable ancestorのownerまたはmodeが不正です");
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function digestOpenFile(handle) {
  const hash = createHash("sha256");
  for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
  return hash.digest("hex");
}

async function recheckExecutableIdentity(identity, dependencies) {
  const check = dependencies.recheckIdentity ?? recheckIdentity;
  await check(identity, dependencies);
}

async function recheckIdentity(identity, dependencies) {
  if (await (dependencies.realpath ?? realpath)(identity.candidate) !== identity.realpath) {
    fail("E_THROUGHLINE_RUNTIME_IDENTITY_CHANGED", "Throughline executable realpathがverification後に変わりました");
  }
  const info = await (dependencies.stat ?? stat)(identity.realpath, { bigint: true });
  const current = {
    uid: Number(info.uid),
    gid: Number(info.gid),
    mode: Number(info.mode & 0o7777n),
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    size: info.size.toString(),
    mtime_ns: info.mtimeNs.toString(),
  };
  for (const key of Object.keys(current)) {
    if (current[key] !== identity[key]) {
      fail("E_THROUGHLINE_RUNTIME_IDENTITY_CHANGED", "Throughline executable identityがverification後に変わりました");
    }
  }
}

function validateVerification(value) {
  if (!isPlainObject(value) || Object.keys(value).sort().join(",") !== "runtime_root,schema,throughline" ||
      value.schema !== THROUGHLINE_PROCESS_VERIFICATION_SCHEMA || typeof value.runtime_root !== "string" ||
      !isAbsolute(value.runtime_root) || normalize(value.runtime_root) !== value.runtime_root || hasControl(value.runtime_root) ||
      !isPlainObject(value.throughline) || Object.keys(value.throughline).sort().join(",") !==
        "candidate,dev,digest,gid,ino,mode,mtime_ns,realpath,size,uid,version" ||
      value.throughline.version !== SUPPORTED_THROUGHLINE_VERSION ||
      ![value.throughline.candidate, value.throughline.realpath].every((entry) =>
        typeof entry === "string" && isAbsolute(entry) && normalize(entry) === entry && !hasControl(entry)) ||
      ![value.throughline.uid, value.throughline.gid, value.throughline.mode].every(Number.isInteger) ||
      ![value.throughline.dev, value.throughline.ino, value.throughline.size, value.throughline.mtime_ns]
        .every((entry) => typeof entry === "string" && /^\d+$/.test(entry)) ||
      typeof value.throughline.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.throughline.digest)) {
    fail("E_THROUGHLINE_PROCESS_VERIFICATION_INVALID", "Throughline process verificationが不正です");
  }
}

function commandOptions(cwd) {
  return { cwd, env: boundedEnv(), timeout: VERSION_TIMEOUT_MS, maxBuffer: MAX_VERSION_BYTES };
}

function boundedEnv(source = process.env) {
  const result = { NO_COLOR: "1" };
  for (const key of ENV_ALLOWLIST) if (typeof source[key] === "string") result[key] = source[key];
  return result;
}

async function runFile(command, args, options) {
  return new Promise((resolveResult) => {
    execFile(command, args, { ...options, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      resolveResult({
        exit_code: error === null ? 0 : Number.isInteger(error.code) ? error.code : null,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
      });
    });
  });
}

function hasControl(value) {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
