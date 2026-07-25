import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;

function run(cwd, command, args, expectedStatus = 0) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    expectedStatus,
    `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
  );
  return result;
}

test("release gateはlanded clean commitだけを受理する", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "observer-release-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repo");
  const remote = join(root, "origin.git");
  await mkdir(join(repository, "scripts"), { recursive: true });
  await cp(
    join(ROOT, "scripts", "verify-release-commit.mjs"),
    join(repository, "scripts", "verify-release-commit.mjs"),
  );
  await writeFile(join(repository, "payload.txt"), "baseline\n");

  run(repository, "git", ["init", "-b", "main"]);
  run(repository, "git", ["config", "user.name", "Observer Test"]);
  run(repository, "git", ["config", "user.email", "observer-test@example.invalid"]);
  run(repository, "git", ["add", "scripts/verify-release-commit.mjs", "payload.txt"]);
  run(repository, "git", ["commit", "-m", "baseline"]);
  run(root, "git", ["init", "--bare", remote]);
  run(repository, "git", ["remote", "add", "origin", remote]);
  run(repository, "git", ["push", "-u", "origin", "main"]);

  run(repository, process.execPath, ["scripts/verify-release-commit.mjs"]);

  await writeFile(join(repository, "payload.txt"), "dirty\n");
  const dirty = run(
    repository,
    process.execPath,
    ["scripts/verify-release-commit.mjs"],
    1,
  );
  assert.match(dirty.stderr, /未commitの変更/);
  run(repository, "git", ["restore", "payload.txt"]);

  await writeFile(join(repository, "untracked.txt"), "untracked\n");
  const untracked = run(
    repository,
    process.execPath,
    ["scripts/verify-release-commit.mjs"],
    1,
  );
  assert.match(untracked.stderr, /未commitの変更/);
  await rm(join(repository, "untracked.txt"));

  await writeFile(join(repository, "payload.txt"), "unpublished\n");
  run(repository, "git", ["add", "payload.txt"]);
  run(repository, "git", ["commit", "-m", "unpublished"]);
  const unpublished = run(
    repository,
    process.execPath,
    ["scripts/verify-release-commit.mjs"],
    1,
  );
  assert.match(unpublished.stderr, /祖先ではありません/);
});

