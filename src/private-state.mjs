import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { fail, ObserverError } from "./observer-error.mjs";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export function defaultStateRoot({ platform = process.platform, home = homedir() } = {}) {
  if (platform !== "darwin") {
    fail("E_PLATFORM_UNSUPPORTED", `Observer v1はmacOSのみ対応です: ${platform}`);
  }
  return join(home, "Library", "Application Support", "Observer");
}

export function assertWithin(root, candidate) {
  if (!isAbsolute(root) || !isAbsolute(candidate)) {
    fail("E_PATH_NOT_ABSOLUTE", "state pathは絶対パスである必要があります");
  }
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const rel = relative(rootPath, candidatePath);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    fail("E_PATH_OUTSIDE_STATE_ROOT", "state root外のpathを拒否しました", { root: rootPath, candidate: candidatePath });
  }
  return candidatePath;
}

function assertOwned(stat, target) {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    fail("E_OWNER_MISMATCH", "所有者が現在userと一致しません", { path: target });
  }
}

export async function assertPrivateDirectory(target) {
  let stat;
  try {
    stat = await lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") fail("E_STATE_DIRECTORY_MISSING", "state directoryが存在しません", { path: target });
    throw error;
  }
  if (stat.isSymbolicLink()) fail("E_SYMLINK_REJECTED", "state directoryのsymlinkを拒否しました", { path: target });
  if (!stat.isDirectory()) fail("E_NOT_DIRECTORY", "state directoryではありません", { path: target });
  assertOwned(stat, target);
  if ((stat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    fail("E_PERMISSION_INVALID", "state directoryは0700である必要があります", { path: target, mode: stat.mode & 0o777 });
  }
  return target;
}

export async function ensurePrivateDirectory(target) {
  try {
    await mkdir(target, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  return assertPrivateDirectory(target);
}

export async function ensureStatePath(stateRoot, ...segments) {
  if (!isAbsolute(stateRoot)) fail("E_PATH_NOT_ABSOLUTE", "state rootは絶対パスである必要があります");
  const root = resolve(stateRoot);
  await ensurePrivateDirectory(root);
  let current = root;
  for (const segment of segments) {
    if (typeof segment !== "string" || segment.length === 0 || basename(segment) !== segment || segment === "." || segment === "..") {
      fail("E_PATH_SEGMENT_INVALID", "不正なstate path segmentです", { segment });
    }
    current = assertWithin(root, join(current, segment));
    await ensurePrivateDirectory(current);
  }
  return current;
}

export async function assertPrivateFile(target) {
  const stat = await lstat(target);
  if (stat.isSymbolicLink()) fail("E_SYMLINK_REJECTED", "state fileのsymlinkを拒否しました", { path: target });
  if (!stat.isFile()) fail("E_NOT_FILE", "state fileではありません", { path: target });
  assertOwned(stat, target);
  if ((stat.mode & 0o777) !== PRIVATE_FILE_MODE) {
    fail("E_PERMISSION_INVALID", "state fileは0600である必要があります", { path: target, mode: stat.mode & 0o777 });
  }
  return target;
}

async function syncDirectory(target) {
  const handle = await open(target, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncPrivateDirectory(target) {
  await assertPrivateDirectory(target);
  await syncDirectory(target);
}

async function writeCompleteTemp(finalPath, data) {
  const parent = dirname(finalPath);
  await assertPrivateDirectory(parent);
  const tempPath = join(parent, `.${basename(finalPath)}.${process.pid}.${randomUUID()}.tmp`);
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(tempPath, flags, PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(data, { encoding: "utf8" });
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw error;
  }
  await handle.close();
  await chmod(tempPath, PRIVATE_FILE_MODE);
  await assertPrivateFile(tempPath);
  return tempPath;
}

async function cleanupTemp(tempPath, primaryError) {
  try {
    await unlink(tempPath);
  } catch (cleanupError) {
    if (cleanupError.code !== "ENOENT") throw new AggregateError([primaryError, cleanupError], "atomic writeとtemp cleanupの両方に失敗しました");
  }
  throw primaryError;
}

export async function atomicCreatePrivateFile(finalPath, data) {
  const tempPath = await writeCompleteTemp(finalPath, data);
  try {
    await link(tempPath, finalPath);
    await unlink(tempPath);
    await assertPrivateFile(finalPath);
    await syncDirectory(dirname(finalPath));
  } catch (error) {
    if (error.code === "EEXIST") {
      await cleanupTemp(tempPath, new ObserverError("E_ALREADY_EXISTS", "既存fileを上書きしません", { path: finalPath }));
    }
    await cleanupTemp(tempPath, error);
  }
  return finalPath;
}

export async function atomicReplacePrivateFile(finalPath, data) {
  try {
    await assertPrivateFile(finalPath);
  } catch (error) {
    if (!(error.code === "ENOENT" || error.code === "E_STATE_FILE_MISSING")) throw error;
  }
  const tempPath = await writeCompleteTemp(finalPath, data);
  try {
    await rename(tempPath, finalPath);
    await assertPrivateFile(finalPath);
    await syncDirectory(dirname(finalPath));
  } catch (error) {
    await cleanupTemp(tempPath, error);
  }
  return finalPath;
}

export async function movePrivateFileNoReplace(sourcePath, finalPath) {
  await assertPrivateFile(sourcePath);
  await assertPrivateDirectory(dirname(finalPath));
  try {
    await lstat(finalPath);
    fail("E_ALREADY_EXISTS", "移動先fileを上書きしません", { path: finalPath });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await rename(sourcePath, finalPath);
  await assertPrivateFile(finalPath);
  await syncDirectory(dirname(sourcePath));
  if (dirname(sourcePath) !== dirname(finalPath)) await syncDirectory(dirname(finalPath));
  return finalPath;
}

export async function removePrivateFile(target) {
  await assertPrivateFile(target);
  await unlink(target);
  await syncDirectory(dirname(target));
}

export async function acquirePrivateLock(lockPath) {
  try {
    await mkdir(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (error.code === "EEXIST") fail("E_CONSUMER_LOCKED", "別consumerがMailboxを処理中です", { path: lockPath });
    throw error;
  }
  await assertPrivateDirectory(lockPath);
  const ownerPath = join(lockPath, "owner.json");
  const owner = {
    schema: "observer.private_lock.v1",
    nonce: randomUUID(),
    pid: process.pid,
    created_at: new Date().toISOString(),
  };
  await atomicCreatePrivateFile(ownerPath, `${JSON.stringify(owner)}\n`);
  let released = false;
  return async () => {
    if (released) return;
    await assertPrivateDirectory(lockPath);
    const currentOwner = await readPrivateJson(ownerPath);
    if (currentOwner.schema !== owner.schema || currentOwner.nonce !== owner.nonce) {
      fail("E_LOCK_OWNERSHIP_MISMATCH", "consumer lockの所有権が変化しました", { path: lockPath });
    }
    await removePrivateFile(ownerPath);
    await rmdir(lockPath);
    await syncDirectory(dirname(lockPath));
    released = true;
  };
}

export async function inspectPrivateLock(lockPath) {
  try {
    await assertPrivateDirectory(lockPath);
  } catch (error) {
    if (error.code === "E_STATE_DIRECTORY_MISSING") return null;
    throw error;
  }
  const ownerPath = join(lockPath, "owner.json");
  try {
    const owner = await readPrivateJson(ownerPath);
    if (owner.schema !== "observer.private_lock.v1" || typeof owner.nonce !== "string") {
      fail("E_LOCK_STATE_INVALID", "consumer lock owner recordが不正です", { path: lockPath });
    }
    return owner;
  } catch (error) {
    if (error.code === "ENOENT") return { schema: "observer.private_lock.v1", nonce: null, pid: null, created_at: null };
    throw error;
  }
}

export async function recoverPrivateLock(lockPath, expectedNonce) {
  const owner = await inspectPrivateLock(lockPath);
  if (owner === null) return false;
  if (owner.nonce !== expectedNonce) fail("E_LOCK_OWNERSHIP_MISMATCH", "確認したlock nonceと一致しません", { path: lockPath });
  const ownerPath = join(lockPath, "owner.json");
  if (owner.nonce !== null) await removePrivateFile(ownerPath);
  const remaining = await readdir(lockPath);
  if (remaining.length !== 0) fail("E_LOCK_STATE_INVALID", "未知fileを含むlockを削除しません", { path: lockPath });
  await rmdir(lockPath);
  await syncDirectory(dirname(lockPath));
  return true;
}

export async function readPrivateJson(target) {
  try {
    await assertPrivateFile(target);
    return JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) fail("E_STATE_JSON_INVALID", "state JSONを解釈できません", { path: target });
    throw error;
  }
}

export async function canonicalDirectory(target) {
  if (!isAbsolute(target)) fail("E_PROJECT_PATH_NOT_ABSOLUTE", "project rootは絶対パスで指定してください");
  const canonical = await realpath(target);
  const stat = await lstat(canonical);
  if (!stat.isDirectory()) fail("E_PROJECT_NOT_DIRECTORY", "project rootがdirectoryではありません", { path: canonical });
  return canonical;
}
