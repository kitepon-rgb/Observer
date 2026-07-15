import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

import { ObserverError, fail } from "./observer-error.mjs";
import {
  atomicCreatePrivateFile,
  assertPrivateDirectory,
  assertWithin,
  canonicalDirectory,
  ensureStatePath,
  readPrivateJson,
} from "./private-state.mjs";

export const TARGET_SCHEMA = "observer.project_target.v1";

export function targetIdForCanonicalProject(canonicalProjectRoot) {
  return `p_${createHash("sha256").update(canonicalProjectRoot, "utf8").digest("hex")}`;
}

export async function resolveProjectTarget(projectRoot) {
  const canonicalProjectRoot = await canonicalDirectory(projectRoot);
  return {
    schema: TARGET_SCHEMA,
    targetId: targetIdForCanonicalProject(canonicalProjectRoot),
    projectRoot: canonicalProjectRoot,
  };
}

export async function registerProjectTarget({ stateRoot, projectRoot }) {
  const target = await resolveProjectTarget(projectRoot);
  const targetsDirectory = await ensureStatePath(stateRoot, "targets");
  const statePath = join(targetsDirectory, `${target.targetId}.json`);
  const data = `${JSON.stringify(target)}\n`;
  try {
    await atomicCreatePrivateFile(statePath, data);
    return { ...target, statePath, created: true };
  } catch (error) {
    if (!(error instanceof ObserverError) || error.code !== "E_ALREADY_EXISTS") throw error;
    const existing = await readPrivateJson(statePath);
    if (existing.schema !== TARGET_SCHEMA || existing.targetId !== target.targetId || existing.projectRoot !== target.projectRoot) {
      fail("E_TARGET_STATE_CONFLICT", "既存target stateがcanonical projectと一致しません", { statePath });
    }
    return { ...target, statePath, created: false };
  }
}

export async function readRegisteredProjectTarget({ stateRoot, projectRoot }) {
  if (typeof stateRoot !== "string" || !isAbsolute(stateRoot)) {
    fail("E_PATH_NOT_ABSOLUTE", "state rootは絶対パスで指定してください");
  }
  const target = await resolveProjectTarget(projectRoot);
  const root = resolve(stateRoot);
  const targetsDirectory = assertWithin(root, join(root, "targets"));
  const statePath = assertWithin(root, join(targetsDirectory, `${target.targetId}.json`));
  let existing;
  try {
    await assertPrivateDirectory(root);
    await assertPrivateDirectory(targetsDirectory);
    existing = await readPrivateJson(statePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "E_STATE_DIRECTORY_MISSING") {
      fail("E_TARGET_NOT_REGISTERED", "project targetが登録されていません");
    }
    throw error;
  }
  if (existing.schema !== TARGET_SCHEMA || existing.targetId !== target.targetId || existing.projectRoot !== target.projectRoot) {
    fail("E_TARGET_STATE_CONFLICT", "既存target stateがcanonical projectと一致しません", { statePath });
  }
  return { ...target, statePath };
}
