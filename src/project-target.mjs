import { createHash } from "node:crypto";
import { join } from "node:path";

import { ObserverError, fail } from "./observer-error.mjs";
import {
  atomicCreatePrivateFile,
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
