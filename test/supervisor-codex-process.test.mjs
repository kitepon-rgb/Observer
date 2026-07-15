import assert from "node:assert/strict";
import test from "node:test";

import {
  createCodexSupervisorRuntime,
  runCodexSupervisorProcess,
} from "../src/supervisor-codex-process.mjs";

const ROOT = "/Users/kite/Developer/Observer";
const THROUGHLINE = "/opt/throughline/bin/throughline";
const CODEX = "/opt/codex/bin/codex";
const TARGET = {
  schema: "observer.project_target.v1",
  targetId: `p_${"a".repeat(64)}`,
  projectRoot: "/project",
};
const WATCH_ID = "w_11111111-1111-4111-8111-111111111111";

test("verified Throughline clientとCodex runtime factoryをprocess lease内へ渡す", async () => {
  const calls = [];
  const client = { read: async () => {}, wait: async () => {} };
  const result = await runCodexSupervisorProcess({
    stateRoot: "/state",
    target: TARGET,
    watchId: WATCH_ID,
    runtimeRoot: ROOT,
    throughlineCommand: THROUGHLINE,
    codexCommand: CODEX,
  }, {
    verifyThroughlineRuntime: async (input) => {
      calls.push(["verify-throughline", input]);
      return { runtime_root: ROOT, marker: "verified" };
    },
    createVerifiedThroughlineClient: ({ verification }) => {
      calls.push(["create-client", verification.marker]);
      return client;
    },
    createCodexSupervisorRuntime: async (input) => {
      calls.push(["create-codex", input]);
      return {
        providerRuntime: { provider: "codex" },
        providerSignal: new AbortController().signal,
        close: async () => {},
      };
    },
    runSupervisorProcess: async (input) => {
      calls.push(["run-process", input.client === client]);
      const owned = await input.createProviderRuntime();
      assert.equal(owned.providerRuntime.provider, "codex");
      await owned.close();
      return { schema: "observer.supervisor_process_result.v1", status: "cancelled", provider: "codex", cycle_id: null };
    },
  });
  assert.equal(result.status, "cancelled");
  assert.deepEqual(calls.map((entry) => entry[0]), [
    "verify-throughline", "create-client", "run-process", "create-codex",
  ]);
  assert.deepEqual(calls[0][1], { runtimeRoot: ROOT, throughlineCommand: THROUGHLINE });
  assert.deepEqual(calls[3][1], { runtimeRoot: ROOT, codexCommand: CODEX });
});

test("Codex runtimeはapp-serverを一度initializeし、closeAndWait所有権を返す", async () => {
  const calls = [];
  const transport = {
    request: async () => {},
    notify: async () => {},
    closeAndWait: async () => { calls.push("close"); },
    terminationSignal: new AbortController().signal,
  };
  const owned = await createCodexSupervisorRuntime({ runtimeRoot: ROOT, codexCommand: CODEX }, {
    verifyCodexAppServerRuntime: async (input) => {
      calls.push(["verify", input]);
      return { runtime_root: ROOT, marker: "verified" };
    },
    startCodexAppServerTransport: async ({ verification }) => {
      calls.push(["start", verification.marker]);
      return transport;
    },
    initializeCodexObserverSession: async ({ session }) => {
      calls.push(["initialize", session === transport]);
    },
  });
  assert.deepEqual(owned.providerRuntime, { provider: "codex", runtime_root: ROOT, session: transport });
  assert.equal(owned.providerSignal, transport.terminationSignal);
  await owned.close();
  assert.deepEqual(calls.map((entry) => Array.isArray(entry) ? entry[0] : entry), ["verify", "start", "initialize", "close"]);
});

test("initialize失敗時もtransport terminal cleanupを確認してから失敗する", async () => {
  let closed = 0;
  const transport = {
    request: async () => {},
    notify: async () => {},
    closeAndWait: async () => { closed += 1; },
    terminationSignal: new AbortController().signal,
  };
  await assert.rejects(createCodexSupervisorRuntime({ runtimeRoot: ROOT, codexCommand: CODEX }, {
    verifyCodexAppServerRuntime: async () => ({ runtime_root: ROOT }),
    startCodexAppServerTransport: async () => transport,
    initializeCodexObserverSession: async () => { throw new Error("initialize failed"); },
  }), /initialize failed/);
  assert.equal(closed, 1);
});
