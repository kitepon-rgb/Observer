import { fail } from "./observer-error.mjs";
import { proposeParentTransition, resolveParentSnapshot, validateParentState } from "./parent-resolver.mjs";
import { validateWaitWire } from "./throughline-client.mjs";

export const MAX_CYCLE_PAGES = 100;
export const MAX_CYCLE_TURNS = 1000;

/**
 * Produces a candidate state only. Persisting that state is deliberately owned
 * by the later supervisor/commit transaction.
 */
export async function runWatchCycle({ target, current = null, client, timeoutSeconds = 3600, signal } = {}) {
  if (!client || typeof client.read !== "function" || typeof client.wait !== "function") {
    fail("E_WATCH_CLIENT", "Throughline clientが不正です");
  }
  if (current === null) return orient({ target, client, signal });
  validateParentState(current);

  const wait = validateWaitWire(
    await client.wait({ projectPath: current.project_root, afterCursor: current.cursor, timeoutSeconds, signal }),
    current.cursor,
  );
  if (wait.status === "timeout") return { status: "timeout", proposed_state: current, turns: [] };
  if (wait.status === "resync_required") fail("E_PARENT_RESYNC_REQUIRED", "parent cursorの再orientationが必要です");
  if (wait.status === "ambiguous_parent") fail("E_PARENT_AMBIGUOUS", "現在親を一意に解決できません");
  if (wait.status !== "changed") fail("E_THROUGHLINE_SCHEMA", "Throughline wait statusが不正です");
  return readChanged({ current, throughCursor: wait.throughCursor, client, signal });
}

async function orient({ target, client, signal }) {
  const read = await client.read({ projectPath: target.projectRoot, signal });
  const resolution = resolveParentSnapshot({ target, readResult: read });
  if (resolution.status === "pending") return { status: "projection_pending", proposed_state: null, turns: [] };
  return { status: "oriented", proposed_state: resolution.state, turns: read.turns };
}

async function readChanged({ current, throughCursor, client, signal }) {
  let pageToken;
  let pages = 0;
  const turns = [];
  for (;;) {
    if (pages++ >= MAX_CYCLE_PAGES) fail("E_THROUGHLINE_READ_BOUNDS", "Throughline page上限を超えました");
    const read = await client.read({
      projectPath: current.project_root,
      afterCursor: current.cursor,
      throughCursor,
      ...(pageToken === undefined ? {} : { pageToken }),
      signal,
    });
    if (read.afterCursor !== current.cursor) {
      fail("E_PARENT_CURSOR_MISMATCH", "read resultがwait cursorへ連結していません");
    }
    const transition = proposeParentTransition({ current, readResult: read });
    if (transition.status === "pending") return { status: "projection_pending", proposed_state: current, turns: [] };
    if (read.throughCursor !== throughCursor) {
      fail("E_PARENT_CURSOR_MISMATCH", "read resultがwait cursorへ連結していません");
    }
    turns.push(...read.turns);
    if (turns.length > MAX_CYCLE_TURNS) fail("E_THROUGHLINE_READ_BOUNDS", "Throughline turn上限を超えました");
    if (transition.status === "resolved") return { status: "changed", proposed_state: transition.state, turns };
    pageToken = transition.nextToken;
  }
}
