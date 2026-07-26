import assert from "node:assert/strict";
import {
  chmod, cp, mkdir, mkdtemp, readFile, realpath, symlink, unlink, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OBSERVER_PRODUCT_DIAGNOSTICS_SCHEMA,
  OBSERVER_PRODUCT_MANIFEST_SCHEMA,
  observerProductManifest,
  runObserverProductDiagnostics,
} from "../src/product-diagnostics.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

test("source package diagnosticsはsanitized manifestと5 binaryを固定する", async () => {
  const result = await runObserverProductDiagnostics({ platform: "darwin", nodeVersion: "22.13.0" });
  assert.equal(result.schema, OBSERVER_PRODUCT_DIAGNOSTICS_SCHEMA);
  assert.equal(result.status, "ready");
  assert.equal(result.manifest.schema, OBSERVER_PRODUCT_MANIFEST_SCHEMA);
  assert.equal(result.manifest.name, "observer");
  assert.equal(result.manifest.version, "0.1.4");
  const distribution = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  assert.equal(distribution.name, "@quolu/observer");
  assert.equal(distribution.version, result.manifest.version);
  assert.equal(Object.hasOwn(distribution, "private"), false);
  assert.deepEqual(result.manifest, observerProductManifest());
  assert.deepEqual(result.manifest.dependencies, [
    { name: "node", version: ">=22.13", scope: "runtime" },
    { name: "throughline", version: ">=0.8.7", scope: "supervisor" },
    { name: "aiterm-mcp", version: "0.14.0", scope: "claude_transport" },
    { name: "codex", version: ">=0.144.3", scope: "codex_host" },
  ]);
  assert.deepEqual(result.checks, [
    { name: "package_manifest", status: "ok" },
    { name: "instruction_files", status: "ok" },
    { name: "bin_integrity", status: "ok" },
    { name: "node_runtime", status: "ok" },
    { name: "platform", status: "ok" },
  ]);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(ROOT), false);
  assert.equal(serialized.includes(process.env.HOME), false);
});

test("unsupported platformはpackage integrityを保ったまま非readyにする", async () => {
  const result = await runObserverProductDiagnostics({ platform: "linux", nodeVersion: "24.0.0" });
  assert.equal(result.status, "unsupported_platform");
  assert.deepEqual(result.checks.at(-1), { name: "platform", status: "unsupported" });
});

test("package manifest tamperと古いNodeは固定errorで失敗する", async () => {
  const root = await copyPackage();
  const manifestPath = join(root, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.name = "tampered";
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  await assert.rejects(runObserverProductDiagnostics({ packageRoot: root }), {
    code: "E_PRODUCT_PACKAGE_INVALID",
  });
  await assert.rejects(runObserverProductDiagnostics({ nodeVersion: "22.12.9" }), {
    code: "E_PRODUCT_NODE_UNSUPPORTED",
  });
});

test("binary modeとsymlink tamperは同じsanitized errorで失敗する", async () => {
  const modeRoot = await copyPackage();
  await chmod(join(modeRoot, "bin/observer.mjs"), 0o644);
  await assert.rejects(runObserverProductDiagnostics({ packageRoot: modeRoot }), {
    code: "E_PRODUCT_BIN_INVALID",
  });

  const linkRoot = await copyPackage();
  const binary = join(linkRoot, "bin/observer-mcp.mjs");
  await unlink(binary);
  await symlink(join(linkRoot, "bin/observer.mjs"), binary);
  await assert.rejects(runObserverProductDiagnostics({ packageRoot: linkRoot }), {
    code: "E_PRODUCT_BIN_INVALID",
  });
});

async function copyPackage() {
  const parent = await mkdtemp(join(tmpdir(), "observer-product-"));
  const root = join(parent, "package");
  await mkdir(root);
  for (const name of [
    "package.json", "AGENTS.md", "CLAUDE.md", "LICENSE", "README.md", "bin", "src", "scripts",
  ]) {
    await cp(join(ROOT, name), join(root, name), { recursive: true });
  }
  return realpath(root);
}
