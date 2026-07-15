import assert from "node:assert/strict";
import test from "node:test";

import { ObserverError } from "../src/observer-error.mjs";
import {
  CHILD_START_SCHEMA,
  completeParentStop,
  confirmParentHostSpawn,
  confirmParentLaunch,
  HOST_RECEIPT_SCHEMA,
  PARENT_AUTHORIZATION_SCHEMA,
  PARENT_LAUNCH_REQUEST_SCHEMA,
  prepareParentLaunch,
  recordParentLaunchFailure,
  requestParentLaunchFailureCleanup,
  requestParentStop,
} from "../src/parent-launch.mjs";

const TARGET_ID = `p_${"a".repeat(64)}`;
const WATCH_ID = "w_11111111-1111-4111-8111-111111111111";
const THREAD_ID = "019f62a1-1111-7111-8111-111111111111";
const TARGET = { schema: "observer.project_target.v1", targetId: TARGET_ID, projectRoot: "/project" };
const STATUS = {
  schema: "observer.watch_status.v1",
  watch_id: WATCH_ID,
  target_id: TARGET_ID,
  project_root: "/project",
  provider: "codex",
  status: "active",
  created_at: "2026-07-15T00:00:00.000Z",
  updated_at: "2026-07-15T00:01:00.000Z",
  fault_code: null,
};

function auth(provider, intent = "start_observer") {
  return { schema: PARENT_AUTHORIZATION_SCHEMA, intent, parent_provider: provider };
}

function receipt(request, handle, outcome = "spawned") {
  return {
    schema: HOST_RECEIPT_SCHEMA,
    provider: request.provider,
    watch_id: request.watch_id,
    target_id: request.target_id,
    outcome,
    handle,
  };
}

function expectCode(code) {
  return (error) => error instanceof ObserverError && error.code === code;
}

function prepareDependencies(provider, calls) {
  return {
    canonicalDirectory: async (path) => { calls.push(["runtime", path]); return "/observer"; },
    registerProjectTarget: async (input) => { calls.push(["target", input]); return { ...TARGET, created: false, statePath: "/state/target.json" }; },
    reserveActiveWatch: async (input) => {
      calls.push(["reserve", input]);
      return { ...STATUS, provider, status: "starting" };
    },
  };
}

test("明示start authorizationが無ければstate操作より先に拒否する", async () => {
  let touched = false;
  const dependencies = {
    canonicalDirectory: async () => { touched = true; },
    registerProjectTarget: async () => { touched = true; },
    reserveActiveWatch: async () => { touched = true; },
  };
  await assert.rejects(
    prepareParentLaunch({ stateRoot: "/state", projectRoot: "/project", runtimeRoot: "/observer" }, dependencies),
    expectCode("E_PARENT_AUTHORIZATION_REQUIRED"),
  );
  await assert.rejects(
    prepareParentLaunch({ stateRoot: "/state", projectRoot: "/project", runtimeRoot: "/observer", authorization: auth("codex", "stop_observer") }, dependencies),
    expectCode("E_PARENT_AUTHORIZATION_REQUIRED"),
  );
  assert.equal(touched, false);
});

test("Codex親はstarting予約後にapp-server thread用の構造化requestを得る", async () => {
  const calls = [];
  const request = await prepareParentLaunch({
    stateRoot: "/state",
    projectRoot: "/project-input",
    runtimeRoot: "/observer-input",
    authorization: auth("codex"),
  }, prepareDependencies("codex", calls));
  assert.deepEqual(calls.map(([name]) => name), ["runtime", "target", "reserve"]);
  assert.equal(request.schema, PARENT_LAUNCH_REQUEST_SCHEMA);
  assert.equal(request.provider, "codex");
  assert.equal(request.required_handle_kind, "codex.thread");
  assert.deepEqual(request.host, {
    kind: "codex.app_server_thread.v1",
    cwd: "/observer",
    approval_policy: "never",
    sandbox: "read-only",
    ephemeral: false,
    service_name: "observer",
  });
  assert.deepEqual(request.child_start, {
    schema: CHILD_START_SCHEMA,
    mode: "observe",
    provider: "codex",
    watch_id: WATCH_ID,
    target_id: TARGET_ID,
    project_root: "/project",
    runtime_root: "/observer",
  });
  assert.equal(JSON.stringify(request).includes("launch_handle"), false);
});

test("Claude親は同じtransactionからbackground agent用requestを得る", async () => {
  const request = await prepareParentLaunch({
    stateRoot: "/state",
    projectRoot: "/project",
    runtimeRoot: "/observer",
    authorization: auth("claude"),
    expectedPreviousWatchId: "w_22222222-2222-4222-8222-222222222222",
  }, prepareDependencies("claude", []));
  assert.equal(request.required_handle_kind, "claude.job");
  assert.deepEqual(request.host, {
    kind: "claude.background_agent.v1",
    agent: "observer",
    name: "observer-aaaaaaaaaaaa-11111111-1111-4111-8111-111111111111",
    cwd: "/observer",
  });
});

test("host spawn handleをlaunchingへ保存した後、同じhandleのready receiptだけでactiveへ進める", async () => {
  const request = await prepareParentLaunch({
    stateRoot: "/state", projectRoot: "/project", runtimeRoot: "/observer", authorization: auth("codex"),
  }, prepareDependencies("codex", []));
  const attached = [];
  const activated = [];
  const dependencies = {
    attachWatchLaunchHandle: async (input) => { attached.push(input); return { ...STATUS, status: "launching" }; },
    activateWatch: async (input) => { activated.push(input); return { ...STATUS, status: "active" }; },
  };
  await assert.rejects(
    confirmParentHostSpawn({ stateRoot: "/state", request, receipt: receipt(request, { kind: "claude.job", value: "6fdf0944" }) }, dependencies),
    expectCode("E_PARENT_HOST_RECEIPT"),
  );
  const launching = await confirmParentHostSpawn({
    stateRoot: "/state",
    request,
    receipt: receipt(request, { kind: "codex.thread", value: THREAD_ID }),
  }, dependencies);
  assert.equal(launching.status, "launching");
  assert.deepEqual(attached, [{ stateRoot: "/state", targetId: TARGET_ID, watchId: WATCH_ID, launchHandle: { kind: "codex.thread", value: THREAD_ID } }]);
  await assert.rejects(
    confirmParentLaunch({ stateRoot: "/state", request, receipt: { ...receipt(request, { kind: "codex.thread", value: THREAD_ID }, "ready"), watch_id: "w_22222222-2222-4222-8222-222222222222" } }, dependencies),
    expectCode("E_PARENT_HOST_RECEIPT_MISMATCH"),
  );
  const active = await confirmParentLaunch({
    stateRoot: "/state",
    request,
    receipt: receipt(request, { kind: "codex.thread", value: THREAD_ID }, "ready"),
  }, dependencies);
  assert.equal(active.status, "active");
  assert.deepEqual(activated, [{ stateRoot: "/state", targetId: TARGET_ID, watchId: WATCH_ID, launchHandle: { kind: "codex.thread", value: THREAD_ID } }]);
});

test("host handle取得前のlaunch failureだけを固定codeでstartingからfaultへ閉じる", async () => {
  const request = await prepareParentLaunch({
    stateRoot: "/state", projectRoot: "/project", runtimeRoot: "/observer", authorization: auth("claude"),
  }, prepareDependencies("claude", []));
  const faults = [];
  const dependencies = {
    recordWatchFaultBeforeChildStart: async (input) => { faults.push(input); return { ...STATUS, status: "faulted", fault_code: input.faultCode }; },
  };
  await assert.rejects(
    recordParentLaunchFailure({ stateRoot: "/state", request, faultCode: "raw stderr" }, dependencies),
    expectCode("E_PARENT_LAUNCH_FAULT_INVALID"),
  );
  const faulted = await recordParentLaunchFailure({ stateRoot: "/state", request, faultCode: "E_OBSERVER_LAUNCH_CORRELATION_FAILED" }, dependencies);
  assert.equal(faulted.fault_code, "E_OBSERVER_LAUNCH_CORRELATION_FAILED");
  assert.deepEqual(faults, [{ stateRoot: "/state", targetId: TARGET_ID, watchId: WATCH_ID, faultCode: "E_OBSERVER_LAUNCH_CORRELATION_FAILED" }]);
});

test("handle保存後のlaunch failureはstoppingで保持し、同じhandleの停止確認後だけfaultedへ閉じる", async () => {
  const request = await prepareParentLaunch({
    stateRoot: "/state", projectRoot: "/project", runtimeRoot: "/observer", authorization: auth("claude"),
  }, prepareDependencies("claude", []));
  const spawnReceipt = receipt(request, { kind: "claude.job", value: "6fdf0944" });
  let faulted = 0;
  const dependencies = {
    requestWatchStop: async () => ({
      status: { ...STATUS, provider: "claude", status: "stopping" },
      launchHandle: { kind: "claude.job", value: "6fdf0944" },
    }),
    recordWatchFaultAfterChildExit: async (input) => { faulted++; return { ...STATUS, provider: "claude", status: "faulted", fault_code: input.faultCode }; },
  };
  const cleanup = await requestParentLaunchFailureCleanup({
    stateRoot: "/state", request, receipt: spawnReceipt, faultCode: "E_OBSERVER_ROUTING_FAILED",
  }, dependencies);
  assert.equal(cleanup.terminal, "faulted");
  assert.equal(cleanup.fault_code, "E_OBSERVER_ROUTING_FAILED");
  assert.deepEqual(cleanup.handle, spawnReceipt.handle);
  assert.equal(faulted, 0);
  const result = await completeParentStop({
    stateRoot: "/state", request: cleanup, receipt: receipt(cleanup, cleanup.handle, "stopped"),
  }, dependencies);
  assert.equal(result.status, "faulted");
  assert.equal(faulted, 1);
});

test("stopは明示authorizationとprovider一致を要求しprivate handleを親だけへ返す", async () => {
  let stopped = false;
  const dependencies = {
    readWatchStatus: async () => STATUS,
    requestWatchStop: async () => {
      stopped = true;
      return { status: { ...STATUS, status: "stopping" }, launchHandle: { kind: "codex.thread", value: THREAD_ID } };
    },
  };
  await assert.rejects(
    requestParentStop({ stateRoot: "/state", targetId: TARGET_ID, watchId: WATCH_ID, authorization: auth("claude", "stop_observer") }, dependencies),
    expectCode("E_PARENT_PROVIDER_MISMATCH"),
  );
  assert.equal(stopped, false);
  const request = await requestParentStop({ stateRoot: "/state", targetId: TARGET_ID, watchId: WATCH_ID, authorization: auth("codex", "stop_observer") }, dependencies);
  assert.equal(request.schema, "observer.parent_stop_request.v1");
  assert.deepEqual(request.handle, { kind: "codex.thread", value: THREAD_ID });
  assert.equal(request.terminal, "stopped");
  assert.equal(request.fault_code, null);
});

test("stop completeは同じstored handleのconfirmed receipt後だけstoppedへ進める", async () => {
  const request = {
    schema: "observer.parent_stop_request.v1",
    provider: "claude",
    watch_id: WATCH_ID,
    target_id: TARGET_ID,
    project_root: "/project",
    handle: { kind: "claude.job", value: "6fdf0944" },
    terminal: "stopped",
    fault_code: null,
  };
  let completed = 0;
  const dependencies = {
    requestWatchStop: async () => ({ status: { ...STATUS, provider: "claude", status: "stopping" }, launchHandle: { kind: "claude.job", value: "6fdf0944" } }),
    completeWatchStop: async () => { completed++; return { ...STATUS, provider: "claude", status: "stopped" }; },
  };
  await assert.rejects(
    completeParentStop({ stateRoot: "/state", request, receipt: receipt(request, { kind: "claude.job", value: "other-job" }, "stopped") }, dependencies),
    expectCode("E_PARENT_STOP_HANDLE_MISMATCH"),
  );
  assert.equal(completed, 0);
  const stopped = await completeParentStop({ stateRoot: "/state", request, receipt: receipt(request, request.handle, "stopped") }, dependencies);
  assert.equal(stopped.status, "stopped");
  assert.equal(completed, 1);
});

test("Codex stopはinterrupt ACKで閉じず同じthread turnのterminal証拠を要求する", async () => {
  const request = {
    schema: "observer.parent_stop_request.v1",
    provider: "codex",
    watch_id: WATCH_ID,
    target_id: TARGET_ID,
    project_root: "/project",
    handle: { kind: "codex.thread", value: THREAD_ID },
    terminal: "stopped",
    fault_code: null,
  };
  const dependencies = {
    requestWatchStop: async () => ({ status: { ...STATUS, status: "stopping" }, launchHandle: request.handle }),
    completeWatchStop: async () => ({ ...STATUS, status: "stopped" }),
  };
  await assert.rejects(
    completeParentStop({ stateRoot: "/state", request, receipt: receipt(request, request.handle, "stopped") }, dependencies),
    expectCode("E_PARENT_HOST_RECEIPT"),
  );
  const terminalReceipt = {
    ...receipt(request, request.handle, "stopped"),
    terminal: {
      schema: "observer.codex_turn_terminal.v1",
      thread_id: THREAD_ID,
      turn_id: "019f62a2-2222-7222-8222-222222222222",
      status: "interrupted",
      observed_at: "2026-07-15T05:00:00.000Z",
    },
  };
  assert.equal((await completeParentStop({ stateRoot: "/state", request, receipt: terminalReceipt }, dependencies)).status, "stopped");
});
