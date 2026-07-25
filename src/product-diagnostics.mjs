import { lstat, readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { SUPPORTED_AITERM_VERSION } from "./aiterm-process-transport.mjs";
import { SUPPORTED_CODEX_VERSION } from "./codex-process-transport.mjs";
import { OBSERVER_MCP_SERVER_VERSION } from "./mcp-server.mjs";
import { fail } from "./observer-error.mjs";
import { SUPPORTED_THROUGHLINE_VERSION } from "./throughline-process-runtime.mjs";

export const OBSERVER_PRODUCT_DIAGNOSTICS_SCHEMA = "observer.product_diagnostics.v1";
export const OBSERVER_PRODUCT_MANIFEST_SCHEMA = "observer.product_manifest.v1";
export const OBSERVER_PRODUCT_VERSION = "0.1.0";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKAGE_DISTRIBUTION_NAME = "@quolu/observer";
const PACKAGE_FILES = Object.freeze([
  "AGENTS.md", "CLAUDE.md", "LICENSE", "README.md", "bin/", "src/",
]);
const PACKAGE_BINS = Object.freeze({
  observer: "bin/observer.mjs",
  "observer-mcp": "bin/observer-mcp.mjs",
  "observer-parent-stop-hook": "bin/observer-parent-stop-hook.mjs",
  "observer-hook-config": "bin/observer-hook-config.mjs",
  "observer-claude-characterization": "bin/observer-claude-characterization.mjs",
});
const MINIMUM_NODE = Object.freeze([22, 13, 0]);

export function observerProductManifest() {
  return {
    schema: OBSERVER_PRODUCT_MANIFEST_SCHEMA,
    name: "observer",
    version: OBSERVER_PRODUCT_VERSION,
    supported_platforms: ["darwin"],
    state: {
      platform: "darwin",
      default_root: "$HOME/Library/Application Support/Observer",
      directory_mode: "0700",
      file_mode: "0600",
    },
    bins: Object.entries(PACKAGE_BINS).map(([name, path]) => ({ name, path })),
    dependencies: [
      { name: "node", version: ">=22.13", scope: "runtime" },
      { name: "throughline", version: SUPPORTED_THROUGHLINE_VERSION, scope: "supervisor" },
      { name: "aiterm-mcp", version: SUPPORTED_AITERM_VERSION, scope: "claude_transport" },
      { name: "codex", version: SUPPORTED_CODEX_VERSION, scope: "codex_host" },
    ],
    diagnostics: [
      { name: "product", command: "observer diagnostics" },
      { name: "mcp", command: "observer-mcp --diagnostics" },
    ],
  };
}

export async function runObserverProductDiagnostics({
  packageRoot = PACKAGE_ROOT,
  platform = process.platform,
  nodeVersion = process.versions.node,
  fileSystem = { lstat, readFile, realpath },
} = {}) {
  await verifyPackageRoot(packageRoot, fileSystem);
  await verifyPackageManifest(packageRoot, fileSystem);
  await verifyInstructionFiles(packageRoot, fileSystem);
  await verifyBins(packageRoot, fileSystem);
  verifyNodeVersion(nodeVersion);

  const supported = platform === "darwin";
  return {
    schema: OBSERVER_PRODUCT_DIAGNOSTICS_SCHEMA,
    status: supported ? "ready" : "unsupported_platform",
    manifest: observerProductManifest(),
    checks: [
      { name: "package_manifest", status: "ok" },
      { name: "instruction_files", status: "ok" },
      { name: "bin_integrity", status: "ok" },
      { name: "node_runtime", status: "ok" },
      { name: "platform", status: supported ? "ok" : "unsupported" },
    ],
  };
}

async function verifyPackageRoot(packageRoot, fileSystem) {
  try {
    const info = await fileSystem.lstat(packageRoot);
    const canonical = await fileSystem.realpath(packageRoot);
    if (!info.isDirectory() || info.isSymbolicLink() || resolve(canonical) !== resolve(packageRoot)) {
      fail("E_PRODUCT_PACKAGE_INVALID", "Observer package rootが不正です");
    }
  } catch (error) {
    rethrowKnownOrFail(error, "E_PRODUCT_PACKAGE_INVALID", "Observer package rootが不正です");
  }
}

async function verifyPackageManifest(packageRoot, fileSystem) {
  const path = resolve(packageRoot, "package.json");
  try {
    await requireRegularFile(path, fileSystem, "E_PRODUCT_PACKAGE_INVALID", "Observer package manifestが不正です");
    const manifest = JSON.parse(await fileSystem.readFile(path, "utf8"));
    if (manifest?.name !== PACKAGE_DISTRIBUTION_NAME ||
        manifest.version !== OBSERVER_PRODUCT_VERSION ||
        Object.hasOwn(manifest, "private") || manifest.type !== "module" ||
        manifest.license !== "MIT" ||
        manifest.repository?.url !== "git+https://github.com/kitepon-rgb/Observer.git" ||
        manifest.publishConfig?.access !== "public" ||
        !sameRecord(manifest.bin, PACKAGE_BINS) || manifest.engines?.node !== ">=22.13" ||
        !sameArray(manifest.files, PACKAGE_FILES)) {
      fail("E_PRODUCT_PACKAGE_INVALID", "Observer package manifestが不正です");
    }
  } catch (error) {
    rethrowKnownOrFail(error, "E_PRODUCT_PACKAGE_INVALID", "Observer package manifestが不正です");
  }
}

async function verifyInstructionFiles(packageRoot, fileSystem) {
  try {
    for (const name of ["AGENTS.md", "CLAUDE.md", "LICENSE", "README.md"]) {
      await requireRegularFile(resolve(packageRoot, name), fileSystem,
        "E_PRODUCT_PACKAGE_INVALID", "Observer instruction fileが不正です");
    }
  } catch (error) {
    rethrowKnownOrFail(error, "E_PRODUCT_PACKAGE_INVALID", "Observer instruction fileが不正です");
  }
}

async function verifyBins(packageRoot, fileSystem) {
  try {
    for (const relativePath of Object.values(PACKAGE_BINS)) {
      const path = resolve(packageRoot, relativePath);
      const info = await requireRegularFile(path, fileSystem,
        "E_PRODUCT_BIN_INVALID", "Observer binaryが不正です");
      const source = await fileSystem.readFile(path, "utf8");
      if ((info.mode & 0o100) === 0 || !source.startsWith("#!/usr/bin/env node\n")) {
        fail("E_PRODUCT_BIN_INVALID", "Observer binaryが不正です");
      }
    }
  } catch (error) {
    rethrowKnownOrFail(error, "E_PRODUCT_BIN_INVALID", "Observer binaryが不正です");
  }
}

async function requireRegularFile(path, fileSystem, code, message) {
  const info = await fileSystem.lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) fail(code, message);
  return info;
}

function verifyNodeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version ?? "");
  if (!match || compareVersion(match.slice(1).map(Number), MINIMUM_NODE) < 0) {
    fail("E_PRODUCT_NODE_UNSUPPORTED", "Observerが対応しないNode runtimeです");
  }
}

function compareVersion(left, right) {
  for (let index = 0; index < right.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function sameArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function sameRecord(actual, expected) {
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
  const keys = Object.keys(expected);
  return Object.keys(actual).length === keys.length && keys.every((key) => actual[key] === expected[key]);
}

function rethrowKnownOrFail(error, code, message) {
  if (error?.code === code) throw error;
  fail(code, message);
}
