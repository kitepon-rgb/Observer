import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ObserverError } from "../src/observer-error.mjs";
import {
  atomicCreatePrivateFile,
  defaultStateRoot,
  ensureStatePath,
} from "../src/private-state.mjs";

async function temporaryRoot() {
  return mkdtemp(join(tmpdir(), "observer-state-"));
}

test("default state rootはmacOSのApplication Support配下になる", () => {
  assert.equal(
    defaultStateRoot({ platform: "darwin", home: "/Users/example" }),
    "/Users/example/Library/Application Support/Observer",
  );
  assert.throws(
    () => defaultStateRoot({ platform: "linux", home: "/home/example" }),
    (error) => error instanceof ObserverError && error.code === "E_PLATFORM_UNSUPPORTED",
  );
});

test("state directoryとfileを0700/0600で作る", async () => {
  const parent = await temporaryRoot();
  const stateRoot = join(parent, "state");
  const inbox = await ensureStatePath(stateRoot, "mailboxes", "p_" + "a".repeat(64), "inbox");
  const messagePath = join(inbox, "message.json");
  await atomicCreatePrivateFile(messagePath, "{}\n");

  assert.equal((await lstat(stateRoot)).mode & 0o777, 0o700);
  assert.equal((await lstat(inbox)).mode & 0o777, 0o700);
  assert.equal((await lstat(messagePath)).mode & 0o777, 0o600);
});

test("不正permissionとsymlink state rootを拒否する", async () => {
  const parent = await temporaryRoot();
  const broad = join(parent, "broad");
  await mkdir(broad, { mode: 0o700 });
  await chmod(broad, 0o755);
  await assert.rejects(
    ensureStatePath(broad, "targets"),
    (error) => error instanceof ObserverError && error.code === "E_PERMISSION_INVALID",
  );

  const real = join(parent, "real");
  const linked = join(parent, "linked");
  await mkdir(real, { mode: 0o700 });
  await symlink(real, linked);
  await assert.rejects(
    ensureStatePath(linked, "targets"),
    (error) => error instanceof ObserverError && error.code === "E_SYMLINK_REJECTED",
  );
});
