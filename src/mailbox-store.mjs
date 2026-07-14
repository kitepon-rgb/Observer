import { access } from "node:fs/promises";
import { join } from "node:path";

import { ObserverError, fail } from "./observer-error.mjs";
import { atomicCreatePrivateFile, ensureStatePath } from "./private-state.mjs";
import { validateMessage } from "./message-schema.mjs";

const TARGET_ID_PATTERN = /^p_[a-f0-9]{64}$/;
const MAILBOX_DIRECTORIES = Object.freeze(["inbox", "processing", "failed", "receipts"]);

function assertTargetId(targetId) {
  if (typeof targetId !== "string" || !TARGET_ID_PATTERN.test(targetId)) fail("E_TARGET_ID_INVALID", "target IDが不正です");
}

export async function ensureMailbox(stateRoot, targetId) {
  assertTargetId(targetId);
  const targetRoot = await ensureStatePath(stateRoot, "mailboxes", targetId);
  const paths = { root: targetRoot };
  for (const name of MAILBOX_DIRECTORIES) paths[name] = await ensureStatePath(stateRoot, "mailboxes", targetId, name);
  return paths;
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function publishMessage({ stateRoot, message, now = new Date() }) {
  validateMessage(message, { now });
  const targetId = message.target.project_target_id;
  const paths = await ensureMailbox(stateRoot, targetId);
  const fileName = `${message.message_id}.json`;
  for (const directory of MAILBOX_DIRECTORIES) {
    if (await exists(join(paths[directory], fileName))) {
      fail("E_MESSAGE_ID_DUPLICATE", "message IDは再利用できません", { messageId: message.message_id });
    }
  }
  const finalPath = join(paths.inbox, fileName);
  try {
    await atomicCreatePrivateFile(finalPath, `${JSON.stringify(message)}\n`);
  } catch (error) {
    if (error instanceof ObserverError && error.code === "E_ALREADY_EXISTS") {
      fail("E_MESSAGE_ID_DUPLICATE", "message IDは再利用できません", { messageId: message.message_id });
    }
    throw error;
  }
  return { messageId: message.message_id, targetId, path: finalPath, contentDigest: message.content_digest };
}
