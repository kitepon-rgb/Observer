import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  EVIDENCE_COLLECTOR_GIT_TIMEOUT_MS,
  collectEvidenceInput,
  collectEvidenceSnapshot,
  createDefaultGitRunner,
} from "../src/evidence-collector.mjs";
import { ObserverError } from "../src/observer-error.mjs";

const SHA = "a".repeat(64);
const CONTEXT = {
  target_id: `p_${SHA}`,
  watch_id: "w_11111111-1111-4111-8111-111111111111",
  parent_host: "codex",
  parent_thread_sha256: "b".repeat(64),
  cycle_id: `c_${"c".repeat(64)}`,
  after_cursor_sha256: null,
  through_cursor_sha256: "d".repeat(64),
};

function digest(label) {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

function request(overrides = {}) {
  return {
    context: CONTEXT,
    turns: [],
    project_root: "/repo",
    plan_refs: ["file:docs/plan.md"],
    test_receipts: [{
      ref: "test:focused",
      source_digest: digest("receipt"),
      available: true,
      command_ref: "node --test focused",
      outcome: "passed",
      observed_at: "2026-07-15T00:00:00.000Z",
      unavailable_code: null,
    }],
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  const files = new Map([["/repo/docs/plan.md", Buffer.from("# approved plan\n")]]);
  return {
    fs: {
      realpath: async (target) => target,
      stat: async (target) => target === "/repo" ? { isDirectory: () => true } : { isFile: () => true, size: files.get(target).byteLength },
      readFile: async (target) => files.get(target),
    },
    runGit: async ({ cwd, args }) => ({ stdout: Buffer.from(`${cwd}:${args.join(" ")}`), stderr: Buffer.alloc(0) }),
    ...overrides,
  };
}

function code(expected) {
  return (error) => error instanceof ObserverError && error.code === expected;
}

test("approved plan、fixed-argv git、既存receiptだけをbuilder inputへ投影する", async () => {
  const calls = [];
  const input = await collectEvidenceInput(request(), dependencies({
    runGit: async (call) => {
      calls.push(call);
      return { stdout: Buffer.from("safe"), stderr: Buffer.alloc(0) };
    },
  }));
  assert.equal(input.plan[0].content, "# approved plan\n");
  assert.equal(input.git.length, 4);
  assert.deepEqual(calls.map(({ args }) => args), [
    ["rev-parse", "HEAD"],
    ["status", "--porcelain=v1", "--branch"],
    ["diff", "--no-ext-diff", "--no-textconv"],
    ["diff", "--cached", "--no-ext-diff", "--no-textconv"],
  ]);
  assert.deepEqual(input.tests, request().test_receipts);
  const snapshot = await collectEvidenceSnapshot(request(), dependencies());
  assert.equal(snapshot.schema, "observer.evidence_snapshot.v1");
});

test("root外へcanonical realpathでescapeするplanはunavailableとして残す", async () => {
  const input = await collectEvidenceInput(request(), dependencies({
    fs: {
      ...dependencies().fs,
      realpath: async (target) => target === "/repo/docs/plan.md" ? "/outside/plan.md" : target,
    },
  }));
  assert.deepEqual(input.plan[0], {
    ref: "file:docs/plan.md",
    source_digest: input.plan[0].source_digest,
    available: false,
    content: null,
    unavailable_code: "PLAN_OUTSIDE_PROJECT",
  });
});

test("巨大・non-UTF8 planとgit出力は部分本文を返さずunavailableにする", async () => {
  const tooLarge = 1024 * 1024 + 1;
  const planInput = await collectEvidenceInput(request(), dependencies({
    fs: { ...dependencies().fs, stat: async (target) => target === "/repo" ? { isDirectory: () => true } : { isFile: () => true, size: tooLarge } },
  }));
  assert.equal(planInput.plan[0].available, false);
  assert.equal(planInput.plan[0].unavailable_code, "PLAN_TOO_LARGE");

  const gitInput = await collectEvidenceInput(request(), dependencies({
    runGit: async () => ({ stdout: Buffer.from([0xff]), stderr: Buffer.alloc(0) }),
  }));
  assert.ok(gitInput.git.every((entry) => entry.available === false && entry.content === null && entry.unavailable_code === "GIT_NON_UTF8"));
});

test("unknown receipt fieldとavailability matrix違反はfail closedにする", async () => {
  await assert.rejects(
    () => collectEvidenceInput(request({ test_receipts: [{ ...request().test_receipts[0], extra: true }] }), dependencies()),
    code("E_EVIDENCE_COLLECTOR_INVALID"),
  );
  await assert.rejects(
    () => collectEvidenceInput(request({ test_receipts: [{ ...request().test_receipts[0], available: false }] }), dependencies()),
    code("E_EVIDENCE_COLLECTOR_INVALID"),
  );
});

test("sparse turns、plan refs、test receiptsをfail closedで拒否する", async () => {
  for (const field of ["turns", "plan_refs", "test_receipts"]) {
    const sparse = [];
    sparse.length = 1;
    await assert.rejects(
      () => collectEvidenceInput(request({ [field]: sparse }), dependencies()),
      code("E_EVIDENCE_COLLECTOR_INVALID"),
    );
  }
});

test("default git runnerは親GIT環境を継承せず、外部起動面とmaxBufferを固定する", async () => {
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = "/attacker-controlled/index";
  const calls = [];
  try {
    const runner = createDefaultGitRunner(async (...call) => {
      calls.push(call);
      return { stdout: Buffer.from("ok"), stderr: Buffer.alloc(0) };
    });
    await runner({ cwd: "/repo", args: ["status"] });
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
  const [executable, args, options] = calls[0];
  assert.equal(executable, "git");
  assert.equal(options.env.GIT_DIR, undefined);
  assert.equal(options.env.GIT_WORK_TREE, undefined);
  assert.equal(options.env.GIT_INDEX_FILE, undefined);
  assert.equal(options.env.GIT_OBJECT_DIRECTORY, undefined);
  assert.equal(options.env.GIT_CONFIG_PARAMETERS, undefined);
  assert.deepEqual(Object.keys(options.env).sort(), [
    "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_EXTERNAL_DIFF", "GIT_OPTIONAL_LOCKS", "GIT_PAGER", "LC_ALL", "PAGER", "PATH",
  ]);
  assert.equal(options.timeout, EVIDENCE_COLLECTOR_GIT_TIMEOUT_MS);
  assert.equal(options.shell, false);
  assert.ok(args.includes("core.fsmonitor=false"));
  assert.ok(args.includes("core.untrackedCache=false"));
  assert.ok(args.includes("--no-optional-locks"));
  assert.ok(args.includes("--no-ext-diff") === false);
});

test("maxBuffer errorはstdout/stderr shapeによらず専用unavailable codeへ分類する", async () => {
  const error = new Error("maxBuffer");
  error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
  const runner = createDefaultGitRunner(async () => { throw error; });
  const input = await collectEvidenceInput(request(), dependencies({ runGit: runner }));
  assert.ok(input.git.every((entry) => entry.available === false && entry.unavailable_code === "GIT_OUTPUT_TOO_LARGE"));
});
