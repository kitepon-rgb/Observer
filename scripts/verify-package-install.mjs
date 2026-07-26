#!/usr/bin/env node

import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const binaryNames = [
  "observer",
  "observer-mcp",
  "observer-parent-stop-hook",
  "observer-hook-config",
  "observer-claude-characterization",
];

function run(command, args, { cwd = projectDirectory, expectedStatus = 0 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    expectedStatus,
    [
      `${command} ${args.join(" ")}: expected ${expectedStatus}, got ${result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"),
  );
  return result;
}

const workRoot = await mkdtemp(join(tmpdir(), "observer-package-"));
try {
  const archiveRoot = join(workRoot, "archive");
  await mkdir(archiveRoot);
  const pack = run(npmCommand, [
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    archiveRoot,
  ]);
  const packed = JSON.parse(pack.stdout);
  assert.equal(packed.length, 1);
  const archivePath = join(archiveRoot, packed[0].filename);

  const prefix = join(workRoot, "prefix");
  run(npmCommand, [
    "install",
    "--global",
    "--prefix",
    prefix,
    archivePath,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ]);

  const installedRoot = join(prefix, "lib", "node_modules", "@quolu", "observer");
  const installedManifest = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
  assert.equal(installedManifest.name, "@quolu/observer");
  assert.equal(installedManifest.version, "0.1.3");
  assert.equal(Object.hasOwn(installedManifest, "private"), false);

  const binRoot = process.platform === "win32" ? prefix : join(prefix, "bin");
  for (const name of binaryNames) {
    await access(join(binRoot, name), process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
  }

  const product = JSON.parse(run(join(binRoot, "observer"), ["diagnostics"], {
    expectedStatus: process.platform === "darwin" ? 0 : 1,
  }).stdout);
  assert.equal(product.manifest.name, "observer");
  assert.equal(product.manifest.version, "0.1.3");
  assert.equal(
    product.status,
    process.platform === "darwin" ? "ready" : "unsupported_platform",
  );

  const mcp = JSON.parse(run(join(binRoot, "observer-mcp"), ["--diagnostics"]).stdout);
  assert.equal(mcp.status, "ready");
  assert.equal(mcp.server_version, "0.1.3");
  assert.deepEqual(mcp.tools, ["observer_read", "observer_wait"]);

  for (const name of [
    "observer-parent-stop-hook",
    "observer-hook-config",
    "observer-claude-characterization",
  ]) {
    run(join(binRoot, name), [], { expectedStatus: 2 });
  }

  console.log("Observer isolated package install smoke passed.");
} finally {
  await rm(workRoot, { recursive: true, force: true });
}
