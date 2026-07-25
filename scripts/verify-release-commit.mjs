#!/usr/bin/env node

// publish対象が、既定ブランチへ着地済みのclean commitから作られることを保証する。
// 未着地branchやdirty treeから出すと、registry payloadとsource lineageが分離する。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const git = (...args) => {
  const result = spawnSync("git", args, {
    cwd: projectDirectory,
    encoding: "utf8",
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
  };
};

const head = git("rev-parse", "HEAD");
assert.ok(head.ok, "git HEADを解決できません");

const originHead = git("symbolic-ref", "--quiet", "refs/remotes/origin/HEAD");
const defaultRef = originHead.ok && originHead.stdout
  ? originHead.stdout.replace("refs/remotes/", "")
  : "origin/main";

const defaultResolved = git("rev-parse", "--verify", `${defaultRef}^{commit}`);
assert.ok(
  defaultResolved.ok,
  `既定ブランチ ${defaultRef} を解決できません。git fetch originを先に実行してください。`,
);

const isAncestor = git("merge-base", "--is-ancestor", head.stdout, defaultRef);
assert.ok(
  isAncestor.ok,
  `publish対象 ${head.stdout.slice(0, 12)} が ${defaultRef} の祖先ではありません。`
    + " 先に既定ブランチへ着地させてpushしてください。",
);

const dirty = git("status", "--porcelain", "--untracked-files=normal");
assert.equal(
  dirty.stdout,
  "",
  `working treeに未commitの変更があります。publish対象commitとpayloadが一致しません:\n${dirty.stdout}`,
);

console.log(`release commit ${head.stdout.slice(0, 12)} is landed on ${defaultRef}.`);

