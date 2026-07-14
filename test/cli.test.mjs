import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const CLI = new URL("../bin/observer.mjs", import.meta.url).pathname;

test("target register CLIは同じprojectを同じtargetへ登録する", async () => {
  const root = await mkdtemp(join(tmpdir(), "observer-cli-"));
  const project = join(root, "project");
  const state = join(root, "state");
  await mkdir(project);

  const first = spawnSync(process.execPath, [CLI, "target", "register", project, "--state-root", state], { encoding: "utf8" });
  const second = spawnSync(process.execPath, [CLI, "target", "register", project, "--state-root", state], { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const created = JSON.parse(first.stdout);
  const existing = JSON.parse(second.stdout);
  assert.equal(created.status, "created");
  assert.equal(existing.status, "existing");
  assert.equal(created.target_id, existing.target_id);
});
