import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ObserverError } from "../src/observer-error.mjs";
import { registerProjectTarget, resolveProjectTarget } from "../src/project-target.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "observer-target-"));
  const stateRoot = join(root, "state");
  const projectA = join(root, "project-a");
  const projectB = join(root, "project-b");
  await mkdir(projectA);
  await mkdir(projectB);
  return { stateRoot, projectA, projectB };
}

test("同じcanonical projectは同じtargetへ安定して登録される", async () => {
  const { stateRoot, projectA } = await fixture();
  const first = await registerProjectTarget({ stateRoot, projectRoot: projectA });
  const second = await registerProjectTarget({ stateRoot, projectRoot: projectA });

  assert.equal(first.targetId, second.targetId);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.statePath, second.statePath);
});

test("別projectは別targetになり、相対pathは拒否される", async () => {
  const { projectA, projectB } = await fixture();
  const targetA = await resolveProjectTarget(projectA);
  const targetB = await resolveProjectTarget(projectB);
  assert.notEqual(targetA.targetId, targetB.targetId);
  await assert.rejects(
    resolveProjectTarget("relative/project"),
    (error) => error instanceof ObserverError && error.code === "E_PROJECT_PATH_NOT_ABSOLUTE",
  );
});
