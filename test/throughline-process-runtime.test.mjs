import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createVerifiedThroughlineClient,
  SUPPORTED_THROUGHLINE_VERSION,
  THROUGHLINE_PROCESS_VERIFICATION_SCHEMA,
  verifyThroughlineRuntime,
} from "../src/throughline-process-runtime.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const THROUGHLINE = "/opt/throughline/bin/throughline";
const IDENTITY = {
  candidate: THROUGHLINE,
  realpath: THROUGHLINE,
  uid: 501,
  gid: 20,
  mode: 0o755,
  dev: "1",
  ino: "2",
  size: "3",
  mtime_ns: "4",
  digest: "a".repeat(64),
};

function verification() {
  return {
    schema: THROUGHLINE_PROCESS_VERIFICATION_SCHEMA,
    runtime_root: ROOT,
    throughline: { ...IDENTITY, version: SUPPORTED_THROUGHLINE_VERSION },
  };
}

test("Throughline executable identityとversionをObserver rootで二重確認する", async () => {
  const calls = [];
  const result = await verifyThroughlineRuntime({ runtimeRoot: ROOT, throughlineCommand: THROUGHLINE }, {
    effectiveUid: 501,
    realpath: async (value) => value,
    inspectExecutable: async (input) => { calls.push(["inspect", input]); return IDENTITY; },
    recheckIdentity: async (identity) => { calls.push(["recheck", identity.realpath]); },
    runFile: async (command, args, options) => {
      calls.push(["run", command, args, options]);
      return { exit_code: 0, stdout: `${SUPPORTED_THROUGHLINE_VERSION}\n`, stderr: "" };
    },
  });
  assert.equal(result.throughline.version, SUPPORTED_THROUGHLINE_VERSION);
  assert.deepEqual(calls.map((entry) => entry[0]), ["inspect", "recheck", "run", "recheck"]);
  assert.deepEqual(calls[2].slice(1, 3), [THROUGHLINE, ["--version"]]);
  assert.equal(calls[2][3].cwd, ROOT);
});

test("verified clientはread/waitごとに同じexecutable identityを再確認する", async () => {
  const calls = [];
  const client = createVerifiedThroughlineClient({ verification: verification() }, {
    recheckIdentity: async (identity) => { calls.push(["recheck", identity.realpath]); },
    createThroughlineClient: ({ command }) => {
      calls.push(["create", command]);
      return {
        read: async (input) => ({ kind: "read", input }),
        wait: async (input) => ({ kind: "wait", input }),
      };
    },
  });
  assert.deepEqual(await client.read({ value: 1 }), { kind: "read", input: { value: 1 } });
  assert.deepEqual(await client.wait({ value: 2 }), { kind: "wait", input: { value: 2 } });
  assert.deepEqual(calls, [
    ["create", THROUGHLINE],
    ["recheck", THROUGHLINE],
    ["recheck", THROUGHLINE],
  ]);
});

test("version不一致とverification改変をfail closedにする", async () => {
  await assert.rejects(
    verifyThroughlineRuntime({ runtimeRoot: ROOT, throughlineCommand: THROUGHLINE }, {
      effectiveUid: 501,
      realpath: async (value) => value,
      inspectExecutable: async () => IDENTITY,
      recheckIdentity: async () => {},
      runFile: async () => ({ exit_code: 0, stdout: "9.9.9\n", stderr: "" }),
    }),
    { code: "E_THROUGHLINE_VERSION_UNSUPPORTED" },
  );
  assert.throws(
    () => createVerifiedThroughlineClient({ verification: { ...verification(), runtime_root: "relative" } }),
    { code: "E_THROUGHLINE_PROCESS_VERIFICATION_INVALID" },
  );
});
