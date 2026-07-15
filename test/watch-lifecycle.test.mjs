import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HOST_RECEIPT_SCHEMA, PARENT_AUTHORIZATION_SCHEMA } from "../src/parent-launch.mjs";
import { readRegisteredProjectTarget } from "../src/project-target.mjs";
import { readWatchStatus } from "../src/watch-store.mjs";
import {
  PARENT_WATCH_CONTEXT_SCHEMA,
  readObserverWatchStatus,
  startObserverWatch,
  stopObserverWatch,
  validateWatchCommandResult,
} from "../src/watch-lifecycle.mjs";

const THREAD_ID = "019f62a1-1111-7111-8111-111111111111";

function context(provider, intent) {
  return {
    schema: PARENT_WATCH_CONTEXT_SCHEMA,
    parent_provider: provider,
    runtime_root: "/observer",
    expected_previous_watch_id: null,
    authorization: {
      schema: PARENT_AUTHORIZATION_SCHEMA,
      intent,
      parent_provider: provider,
    },
  };
}

function handleFor(provider) {
  return provider === "codex"
    ? { kind: "codex.thread", value: THREAD_ID }
    : { kind: "claude.job", value: "job_1234" };
}

function receipt(request, outcome, handle = handleFor(request.provider)) {
  const value = {
    schema: HOST_RECEIPT_SCHEMA,
    provider: request.provider,
    watch_id: request.watch_id,
    target_id: request.target_id,
    outcome,
    handle,
  };
  if (request.provider === "codex" && outcome === "stopped") {
    value.terminal = {
      schema: "observer.codex_turn_terminal.v1",
      thread_id: handle.value,
      turn_id: "019f62a2-2222-7222-8222-222222222222",
      status: "interrupted",
      observed_at: "2026-07-16T00:00:00.000Z",
    };
  }
  return value;
}

function adapter(provider, events, { terminal = true } = {}) {
  return {
    provider,
    available: true,
    spawn: async ({ request }) => {
      events.push(`${provider}:spawn`);
      return receipt(request, "spawned");
    },
    ready: async ({ request }) => {
      events.push(`${provider}:ready`);
      return receipt(request, "ready");
    },
    stop: async ({ request }) => {
      events.push(`${provider}:stop`);
      return terminal ? receipt(request, "stopped", request.handle) : null;
    },
  };
}

async function fixture(provider, options) {
  const root = await mkdtemp(join(tmpdir(), `observer-watch-${provider}-`));
  const projectRoot = join(root, "project");
  const runtimeRoot = join(root, "runtime");
  const stateRoot = join(root, "state");
  await mkdir(projectRoot);
  await mkdir(runtimeRoot);
  const events = [];
  const parentContext = context(provider, "start_observer");
  parentContext.runtime_root = runtimeRoot;
  const hostActions = { [provider]: adapter(provider, events, options) };
  return { stateRoot, projectRoot, runtimeRoot, events, parentContext, hostActions };
}

test("host adapter欠損はtarget登録とwatch予約より前にprovider_unavailableを返す", async () => {
  let touched = false;
  const result = await startObserverWatch({
    stateRoot: "/state",
    projectRoot: "/project",
    parentContext: context("claude", "start_observer"),
  }, {
    hostActions: {},
    prepareParentLaunch: async () => { touched = true; },
  });
  assert.deepEqual(result, {
    schema: "observer.watch_command_result.v1",
    action: "start",
    status: "provider_unavailable",
    provider: "claude",
    watch: null,
  });
  assert.equal(touched, false);
});

for (const provider of ["claude", "codex"]) {
  test(`${provider} fake host actionは共通start/status/stop resultでprivate handleを隠す`, async () => {
    const current = await fixture(provider);
    const started = await startObserverWatch(current, { hostActions: current.hostActions });
    assert.equal(started.status, "active");
    assert.equal(started.provider, provider);
    assert.equal(JSON.stringify(started).includes(handleFor(provider).value), false);
    assert.deepEqual(current.events, [`${provider}:spawn`, `${provider}:ready`]);

    const status = await readObserverWatchStatus(current);
    assert.equal(status.status, "active");
    assert.deepEqual(status.watch, started.watch);
    assert.equal(Object.hasOwn(status.watch, "launch_handle"), false);

    await assert.rejects(
      startObserverWatch(current, { hostActions: current.hostActions }),
      { code: "E_WATCH_ALREADY_ACTIVE" },
    );
    assert.deepEqual(current.events, [`${provider}:spawn`, `${provider}:ready`]);

    const stopContext = context(provider, "stop_observer");
    stopContext.runtime_root = current.runtimeRoot;
    const stopped = await stopObserverWatch({ ...current, parentContext: stopContext }, {
      hostActions: current.hostActions,
    });
    assert.equal(stopped.status, "stopped");
    assert.equal(JSON.stringify(stopped).includes(handleFor(provider).value), false);
    assert.deepEqual(current.events, [`${provider}:spawn`, `${provider}:ready`, `${provider}:stop`]);
  });
}

test("terminal receipt未確定のstopはstoppingを保持し、再要求のexact receiptだけで閉じる", async () => {
  const current = await fixture("codex", { terminal: false });
  await startObserverWatch(current, { hostActions: current.hostActions });
  const stopContext = context("codex", "stop_observer");
  stopContext.runtime_root = current.runtimeRoot;
  const unavailable = await stopObserverWatch({ ...current, parentContext: stopContext }, {
    hostActions: { codex: { available: false } },
  });
  assert.equal(unavailable.status, "provider_unavailable");
  assert.equal((await readWatchStatus({
    stateRoot: current.stateRoot,
    targetId: unavailable.watch.target_id,
  })).status, "active");

  const stopping = await stopObserverWatch({ ...current, parentContext: stopContext }, {
    hostActions: current.hostActions,
  });
  assert.equal(stopping.status, "stopping");
  assert.equal((await readWatchStatus({
    stateRoot: current.stateRoot,
    targetId: stopping.watch.target_id,
  })).status, "stopping");

  current.hostActions.codex = adapter("codex", current.events);
  const stopped = await stopObserverWatch({ ...current, parentContext: stopContext }, {
    hostActions: current.hostActions,
  });
  assert.equal(stopped.status, "stopped");
});

test("terminal watchの再startは観測済みprevious IDだけを受け入れる", async () => {
  const current = await fixture("claude");
  const started = await startObserverWatch(current, { hostActions: current.hostActions });
  const stopContext = context("claude", "stop_observer");
  stopContext.runtime_root = current.runtimeRoot;
  const stopped = await stopObserverWatch({ ...current, parentContext: stopContext }, {
    hostActions: current.hostActions,
  });
  assert.equal(stopped.status, "stopped");

  const staleContext = context("claude", "start_observer");
  staleContext.runtime_root = current.runtimeRoot;
  staleContext.expected_previous_watch_id = "w_22222222-2222-4222-8222-222222222222";
  await assert.rejects(startObserverWatch({ ...current, parentContext: staleContext }, {
    hostActions: current.hostActions,
  }), { code: "E_WATCH_STATE_CHANGED" });

  const restartContext = context("claude", "start_observer");
  restartContext.runtime_root = current.runtimeRoot;
  restartContext.expected_previous_watch_id = stopped.watch.watch_id;
  const restarted = await startObserverWatch({ ...current, parentContext: restartContext }, {
    hostActions: current.hostActions,
  });
  assert.equal(restarted.status, "active");
  assert.notEqual(restarted.watch.watch_id, started.watch.watch_id);
});

test("wrong-provider stopはstoppingへ遷移せず、public result validatorはhandle混入を拒否する", async () => {
  const current = await fixture("codex");
  await startObserverWatch(current, { hostActions: current.hostActions });
  const target = await readRegisteredProjectTarget(current);
  const wrong = context("claude", "stop_observer");
  wrong.runtime_root = current.runtimeRoot;
  await assert.rejects(stopObserverWatch({ ...current, parentContext: wrong }, {
    hostActions: { claude: adapter("claude", []) },
  }), { code: "E_PARENT_PROVIDER_MISMATCH" });
  assert.equal((await readWatchStatus({ stateRoot: current.stateRoot, targetId: target.targetId })).status, "active");
  const publicStatus = (await readObserverWatchStatus(current)).watch;

  assert.throws(() => validateWatchCommandResult({
    schema: "observer.watch_command_result.v1",
    action: "status",
    status: "active",
    provider: "codex",
    watch: { ...publicStatus, launch_handle: handleFor("codex") },
  }), { code: "E_WATCH_COMMAND_RESULT_INVALID" });
});
