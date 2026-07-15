import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  activateCodexObserver,
  activateCodexGenerationObserver,
  initializeCodexObserverSession,
  observeCodexGenerationTerminal,
  readCodexObserverThread,
  recoverCodexGenerationReady,
  recoverCodexGenerationSpawn,
  recoverCodexObserverReady,
  resumeCodexObserverThread,
  spawnCodexGenerationObserverThread,
  spawnCodexObserverThread,
  stopCodexObserver,
} from "../src/codex-host-runtime.mjs";
import { ObserverError } from "../src/observer-error.mjs";

const ROOT = "/Users/kite/Developer/Observer";
const THREAD_ID = "019f62a1-1111-7111-8111-111111111111";
const TURN_ID = "019f62a2-2222-7222-8222-222222222222";
const OTHER_TURN_ID = "019f62a6-6666-7666-8666-666666666666";
const TARGET_ID = `p_${"a".repeat(64)}`;
const WATCH_ID = "w_11111111-1111-4111-8111-111111111111";
const NOW = "2026-07-15T05:00:00.000Z";
const GENERATION_ID = `sha256:${"a".repeat(64)}`;

function launchRequest() {
  return {
    schema: "observer.parent_launch_request.v1",
    provider: "codex",
    watch_id: WATCH_ID,
    target_id: TARGET_ID,
    project_root: "/monitored/project",
    runtime_root: ROOT,
    required_handle_kind: "codex.thread",
    host: { kind: "codex.app_server_thread.v1", cwd: ROOT, approval_policy: "never", sandbox: "read-only", ephemeral: false, service_name: "observer" },
    child_start: { schema: "observer.child_start.v1", mode: "observe", provider: "codex", watch_id: WATCH_ID, target_id: TARGET_ID, project_root: "/monitored/project", runtime_root: ROOT },
  };
}

function stopRequest() {
  return {
    schema: "observer.parent_stop_request.v1", provider: "codex", watch_id: WATCH_ID, target_id: TARGET_ID,
    project_root: "/monitored/project", handle: { kind: "codex.thread", value: THREAD_ID }, terminal: "stopped", fault_code: null,
  };
}

function threadResult(turns = []) {
  return {
    cwd: ROOT,
    approvalPolicy: "never",
    sandbox: { type: "readOnly", networkAccess: false },
    instructionSources: [`${ROOT}/AGENTS.md`],
    thread: { id: THREAD_ID, cwd: ROOT, ephemeral: false, modelProvider: "openai", turns },
  };
}

class FakeSession {
  constructor(handler) {
    this.handler = handler;
    this.calls = [];
  }

  async request(method, params) {
    this.calls.push(["request", method, params]);
    if (method === "initialize") return { codexHome: "/codex", platformFamily: "unix", platformOs: "macos", userAgent: "codex-cli 0.144.3" };
    return this.handler(method, params);
  }

  async notify(method, params) {
    this.calls.push(["notify", method, params]);
  }
}

async function stateRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "observer-codex-runtime-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function expectCode(code) {
  return (error) => error instanceof ObserverError && error.code === code;
}

async function initialize(session) {
  return initializeCodexObserverSession({ session }, { now: () => NOW });
}

test("connectionごとにinitialize response後のinitializedを先行する", async () => {
  const session = new FakeSession(() => { throw new Error("unexpected"); });
  const verification = await initialize(session);
  assert.equal(verification.user_agent, "codex-cli 0.144.3");
  assert.deepEqual(session.calls.map((entry) => entry.slice(0, 2)), [["request", "initialize"], ["notify", "initialized"]]);
  await assert.rejects(initialize(session), expectCode("E_CODEX_CONNECTION_ALREADY_INITIALIZED"));
});

test("initialize結果不明または不正のsessionを再initializeしない", async () => {
  const session = new FakeSession(() => { throw new Error("unexpected"); });
  session.request = async () => ({ invalid: true });
  await assert.rejects(initialize(session), expectCode("E_CODEX_INITIALIZE_RESULT_INVALID"));
  await assert.rejects(initialize(session), expectCode("E_CODEX_CONNECTION_ALREADY_INITIALIZED"));
});

test("thread handleを親stateへ耐久化してからだけturn/startし別turn handleをjournalへ保存する", async (t) => {
  const root = await stateRoot(t);
  const order = [];
  const session = new FakeSession(async (method) => {
    order.push(method);
    if (method === "thread/start") return threadResult();
    if (method === "turn/start") return { turn: { id: TURN_ID, status: "inProgress", items: [] } };
    throw new Error(`unexpected ${method}`);
  });
  await initialize(session);
  const spawned = await spawnCodexObserverThread({ stateRoot: root, request: launchRequest(), session }, { now: () => NOW });
  assert.deepEqual(spawned.receipt.handle, { kind: "codex.thread", value: THREAD_ID });
  assert.equal(spawned.journal.status, "thread_created");
  const activated = await activateCodexObserver({ stateRoot: root, request: launchRequest(), spawnResult: spawned, session }, {
    now: () => NOW,
    confirmParentHostSpawn: async () => { order.push("parent-handle-durable"); return { status: "launching" }; },
    confirmParentLaunch: async () => { order.push("parent-active"); return { status: "active" }; },
  });
  assert.deepEqual(order, ["thread/start", "parent-handle-durable", "turn/start", "parent-active"]);
  assert.equal(activated.operation.thread_id, THREAD_ID);
  assert.equal(activated.operation.turn_id, TURN_ID);
  assert.equal(activated.journal.status, "running");
  assert.equal(activated.journal.cycle_id, WATCH_ID);
});

test("thread/start結果不明はcwd singletonへattachせず耐久unknownで同watch再spawnを拒否する", async (t) => {
  const root = await stateRoot(t);
  let starts = 0;
  const session = new FakeSession(async (method) => {
    if (method === "thread/start") { starts += 1; throw new Error("connection closed"); }
    throw new Error(`unexpected ${method}`);
  });
  await initialize(session);
  await assert.rejects(spawnCodexObserverThread({ stateRoot: root, request: launchRequest(), session }, { now: () => NOW }), expectCode("E_CODEX_THREAD_START_UNKNOWN"));
  await assert.rejects(spawnCodexObserverThread({ stateRoot: root, request: launchRequest(), session }, { now: () => NOW }), expectCode("E_CODEX_LAUNCH_ALREADY_RECORDED"));
  assert.equal(starts, 1);
  const journal = JSON.parse(await readFile(join(root, "codex-operations", TARGET_ID, `${WATCH_ID}.json`), "utf8"));
  assert.equal(journal.status, "thread_start_unknown");
  assert.equal(journal.thread_id, null);
});

test("rollover Codex journalはgeneration IDでnamespaceし旧terminal journalを上書きしない", async (t) => {
  const root = await stateRoot(t);
  const generationA = `sha256:${"a".repeat(64)}`;
  const generationB = `sha256:${"b".repeat(64)}`;
  const threadA = "019f62a3-3333-7333-8333-333333333333";
  const threadB = "019f62a4-4444-7444-8444-444444444444";
  let starts = 0;
  const session = new FakeSession(async (method) => {
    if (method !== "thread/start") throw new Error(`unexpected ${method}`);
    starts += 1;
    const threadId = starts === 1 ? threadA : threadB;
    return { ...threadResult(), thread: { ...threadResult().thread, id: threadId } };
  });
  await initialize(session);
  const first = await spawnCodexObserverThread({ stateRoot: root, request: launchRequest(), session, generationId: generationA }, { now: () => NOW });
  const second = await spawnCodexObserverThread({ stateRoot: root, request: launchRequest(), session, generationId: generationB }, { now: () => NOW });
  assert.equal(first.receipt.handle.value, threadA);
  assert.equal(second.receipt.handle.value, threadB);
  const base = join(root, "codex-operations", TARGET_ID);
  const firstJournal = JSON.parse(await readFile(join(base, `${WATCH_ID}.${"a".repeat(64)}.json`), "utf8"));
  const secondJournal = JSON.parse(await readFile(join(base, `${WATCH_ID}.${"b".repeat(64)}.json`), "utf8"));
  assert.equal(firstJournal.thread_id, threadA);
  assert.equal(secondJournal.thread_id, threadB);
});

test("turn/start結果不明はturn IDを推測せず同cycle再実行とready回収を拒否する", async (t) => {
  const root = await stateRoot(t);
  let turns = 0;
  const session = new FakeSession(async (method) => {
    if (method === "thread/start") return threadResult();
    if (method === "turn/start") { turns += 1; throw new Error("connection closed"); }
    throw new Error(`unexpected ${method}`);
  });
  await initialize(session);
  const spawned = await spawnCodexObserverThread({ stateRoot: root, request: launchRequest(), session }, { now: () => NOW });
  const dependencies = { now: () => NOW, confirmParentHostSpawn: async () => ({ status: "launching" }) };
  await assert.rejects(activateCodexObserver({ stateRoot: root, request: launchRequest(), spawnResult: spawned, session }, dependencies), expectCode("E_CODEX_TURN_START_UNKNOWN"));
  await assert.rejects(activateCodexObserver({ stateRoot: root, request: launchRequest(), spawnResult: spawned, session }, dependencies), expectCode("E_CODEX_JOURNAL_TRANSITION_INVALID"));
  await assert.rejects(recoverCodexObserverReady({ stateRoot: root, request: launchRequest(), session }), expectCode("E_CODEX_READY_RECOVERY_UNAVAILABLE"));
  assert.equal(turns, 1);
});

test("thread/readは照合専用、thread/resumeは継続購読専用として別methodを使う", async () => {
  const session = new FakeSession(async (method) => {
    if (method === "thread/read") return { thread: { id: THREAD_ID, cwd: ROOT, turns: [{ id: TURN_ID, status: "inProgress", items: [] }] } };
    if (method === "thread/resume") return threadResult();
    throw new Error(`unexpected ${method}`);
  });
  await initialize(session);
  const read = await readCodexObserverThread({ request: launchRequest(), threadId: THREAD_ID, session }, { now: () => NOW });
  assert.deepEqual(read.turns, [{ turn_id: TURN_ID, status: "inProgress" }]);
  const resumed = await resumeCodexObserverThread({ request: launchRequest(), threadId: THREAD_ID, session }, { now: () => NOW });
  assert.equal(resumed.subscribed, true);
  assert.deepEqual(session.calls.filter((entry) => entry[1]?.startsWith("thread/")).map((entry) => entry[1]), ["thread/read", "thread/resume"]);
});

test("interrupt空ACKではstoppingを維持し同じturnのterminal read後だけ停止receiptを返す", async (t) => {
  const root = await stateRoot(t);
  let terminal = false;
  const session = new FakeSession(async (method) => {
    if (method === "thread/start") return threadResult();
    if (method === "turn/start") return { turn: { id: TURN_ID, status: "inProgress", items: [] } };
    if (method === "thread/read") return { thread: { id: THREAD_ID, cwd: ROOT, turns: [{ id: TURN_ID, status: terminal ? "interrupted" : "inProgress", items: [] }] } };
    if (method === "turn/interrupt") { terminal = true; return {}; }
    throw new Error(`unexpected ${method}`);
  });
  await initialize(session);
  const spawned = await spawnCodexObserverThread({ stateRoot: root, request: launchRequest(), session }, { now: () => NOW });
  await activateCodexObserver({ stateRoot: root, request: launchRequest(), spawnResult: spawned, session }, {
    now: () => NOW,
    confirmParentHostSpawn: async () => ({ status: "launching" }),
    confirmParentLaunch: async () => ({ status: "active" }),
  });
  const issued = await stopCodexObserver({ stateRoot: root, request: stopRequest(), launchRequest: launchRequest(), session }, { now: () => NOW });
  assert.equal(issued.command_receipt.outcome, "acknowledged");
  assert.equal(issued.terminal_receipt, null);
  assert.equal(issued.journal.status, "stopping");
  const completed = await stopCodexObserver({ stateRoot: root, request: stopRequest(), launchRequest: launchRequest(), session, previousInterruptReceipt: issued.command_receipt }, { now: () => NOW });
  assert.equal(completed.terminal_receipt.terminal.thread_id, THREAD_ID);
  assert.equal(completed.terminal_receipt.terminal.turn_id, TURN_ID);
  assert.equal(completed.terminal_receipt.terminal.status, "interrupted");
  assert.equal(completed.journal.status, "interrupted");
});

test("interrupt結果不明はstoppingを耐久化し同じturnへ再送しない", async (t) => {
  const root = await stateRoot(t);
  let interrupts = 0;
  const session = new FakeSession(async (method) => {
    if (method === "thread/start") return threadResult();
    if (method === "turn/start") return { turn: { id: TURN_ID, status: "inProgress", items: [] } };
    if (method === "thread/read") return { thread: { id: THREAD_ID, cwd: ROOT, turns: [{ id: TURN_ID, status: "inProgress", items: [] }] } };
    if (method === "turn/interrupt") { interrupts += 1; throw new Error("connection closed"); }
    throw new Error(`unexpected ${method}`);
  });
  await initialize(session);
  const spawned = await spawnCodexObserverThread({ stateRoot: root, request: launchRequest(), session }, { now: () => NOW });
  await activateCodexObserver({ stateRoot: root, request: launchRequest(), spawnResult: spawned, session }, {
    now: () => NOW,
    confirmParentHostSpawn: async () => ({ status: "launching" }),
    confirmParentLaunch: async () => ({ status: "active" }),
  });
  await assert.rejects(
    stopCodexObserver({ stateRoot: root, request: stopRequest(), launchRequest: launchRequest(), session }, { now: () => NOW }),
    expectCode("E_CODEX_INTERRUPT_RESULT_UNKNOWN"),
  );
  const pending = await stopCodexObserver({ stateRoot: root, request: stopRequest(), launchRequest: launchRequest(), session }, { now: () => NOW });
  assert.equal(pending.journal.status, "stopping");
  assert.equal(pending.terminal_receipt, null);
  assert.equal(interrupts, 1);
});

test("Codex generation runtimeはgeneration namespaceを必須にして親watch遷移を呼ばない", async (t) => {
  const root = await stateRoot(t);
  const session = new FakeSession(async (method) => {
    if (method === "thread/start") return threadResult();
    if (method === "turn/start") return { turn: { id: TURN_ID, status: "inProgress", items: [] } };
    throw new Error(`unexpected ${method}`);
  });
  await initialize(session);
  await assert.rejects(
    spawnCodexGenerationObserverThread({ stateRoot: root, request: launchRequest(), session }),
    expectCode("E_CODEX_GENERATION_ID_REQUIRED"),
  );
  const spawned = await spawnCodexGenerationObserverThread({
    stateRoot: root, request: launchRequest(), session, generationId: GENERATION_ID,
  }, { now: () => NOW });
  const activated = await activateCodexGenerationObserver({
    stateRoot: root, request: launchRequest(), spawnResult: spawned, session, generationId: GENERATION_ID,
  }, {
    now: () => NOW,
    confirmParentHostSpawn: async () => { throw new Error("must not call parent spawn"); },
    confirmParentLaunch: async () => { throw new Error("must not call parent ready"); },
  });
  assert.equal(activated.ready_receipt.outcome, "ready");
  assert.equal(activated.operation.thread_id, THREAD_ID);
  assert.equal(activated.operation.turn_id, TURN_ID);
  assert.equal(activated.journal.status, "running");
  assert.equal(Object.hasOwn(activated, "watch_status"), false);
});

test("Codex generation runtimeはdurable journalと異なるspawn handleを拒否する", async (t) => {
  const root = await stateRoot(t);
  const session = new FakeSession(async (method) => {
    if (method === "thread/start") return threadResult();
    throw new Error(`unexpected ${method}`);
  });
  await initialize(session);
  const spawned = await spawnCodexGenerationObserverThread({
    stateRoot: root, request: launchRequest(), session, generationId: GENERATION_ID,
  }, { now: () => NOW });
  const conflicting = structuredClone(spawned);
  conflicting.receipt.handle.value = "019f62a5-5555-7555-8555-555555555555";
  await assert.rejects(
    activateCodexGenerationObserver({
      stateRoot: root, request: launchRequest(), spawnResult: conflicting, session, generationId: GENERATION_ID,
    }, { now: () => NOW }),
    expectCode("E_CODEX_SPAWN_RESULT_INVALID"),
  );
  assert.equal(session.calls.filter((entry) => entry[1] === "turn/start").length, 0);
});

test("Codex generation spawn recoveryはjournal欠損とthread_start_unknownをunknownのまま再送しない", async (t) => {
  const root = await stateRoot(t);
  let starts = 0;
  const session = new FakeSession(async (method) => {
    if (method === "thread/start") { starts += 1; throw new Error("connection closed"); }
    throw new Error(`unexpected ${method}`);
  });
  await initialize(session);
  const missing = await recoverCodexGenerationSpawn({
    stateRoot: root, request: launchRequest(), generationId: GENERATION_ID,
  });
  assert.deepEqual(missing, {
    schema: "observer.codex_generation_recovery_result.v1",
    outcome: "unknown",
    reason: "journal_missing",
    receipt: null,
  });
  await assert.rejects(
    spawnCodexGenerationObserverThread({ stateRoot: root, request: launchRequest(), session, generationId: GENERATION_ID }, { now: () => NOW }),
    expectCode("E_CODEX_THREAD_START_UNKNOWN"),
  );
  const unknown = await recoverCodexGenerationSpawn({
    stateRoot: root, request: launchRequest(), generationId: GENERATION_ID,
  });
  assert.equal(unknown.outcome, "unknown");
  assert.equal(unknown.reason, "thread_start_unknown");
  assert.equal(unknown.receipt, null);
  assert.equal(starts, 1);
});

test("Codex generation recoveryはdurable thread spawnと同一inProgress turnのreadyだけを返す", async (t) => {
  const root = await stateRoot(t);
  const session = new FakeSession(async (method) => {
    if (method === "thread/start") return threadResult();
    if (method === "turn/start") return { turn: { id: TURN_ID, status: "inProgress", items: [] } };
    if (method === "thread/read") return { thread: { id: THREAD_ID, cwd: ROOT, turns: [{ id: TURN_ID, status: "inProgress", items: [] }] } };
    throw new Error(`unexpected ${method}`);
  });
  await initialize(session);
  const spawned = await spawnCodexGenerationObserverThread({
    stateRoot: root, request: launchRequest(), session, generationId: GENERATION_ID,
  }, { now: () => NOW });
  const recoveredSpawn = await recoverCodexGenerationSpawn({
    stateRoot: root, request: launchRequest(), generationId: GENERATION_ID,
  });
  assert.equal(recoveredSpawn.outcome, "spawned");
  assert.deepEqual(recoveredSpawn.receipt, spawned.receipt);

  await activateCodexGenerationObserver({
    stateRoot: root, request: launchRequest(), spawnResult: recoveredSpawn, session, generationId: GENERATION_ID,
  }, { now: () => NOW });
  const ready = await recoverCodexGenerationReady({
    stateRoot: root, request: launchRequest(), session, generationId: GENERATION_ID,
  }, {
    now: () => NOW,
    confirmParentHostSpawn: async () => { throw new Error("must not call parent spawn"); },
    confirmParentLaunch: async () => { throw new Error("must not call parent ready"); },
  });
  assert.equal(ready.outcome, "ready");
  assert.equal(ready.receipt.outcome, "ready");
  assert.equal(ready.operation.thread_id, THREAD_ID);
  assert.equal(ready.operation.turn_id, TURN_ID);
  assert.deepEqual(session.calls.filter((entry) => entry[1] === "turn/start").length, 1);
});

test("Codex generation turn_start_unknown recoveryは別turnを開始しない", async (t) => {
  const root = await stateRoot(t);
  let turns = 0;
  const session = new FakeSession(async (method) => {
    if (method === "thread/start") return threadResult();
    if (method === "turn/start") { turns += 1; throw new Error("connection closed"); }
    throw new Error(`unexpected ${method}`);
  });
  await initialize(session);
  const spawned = await spawnCodexGenerationObserverThread({
    stateRoot: root, request: launchRequest(), session, generationId: GENERATION_ID,
  }, { now: () => NOW });
  await assert.rejects(
    activateCodexGenerationObserver({ stateRoot: root, request: launchRequest(), spawnResult: spawned, session, generationId: GENERATION_ID }, { now: () => NOW }),
    expectCode("E_CODEX_TURN_START_UNKNOWN"),
  );
  const recovered = await recoverCodexGenerationReady({
    stateRoot: root, request: launchRequest(), session, generationId: GENERATION_ID,
  }, { now: () => NOW });
  assert.equal(recovered.outcome, "unknown");
  assert.equal(recovered.reason, "turn_start_unknown");
  assert.equal(recovered.receipt, null);
  assert.equal(turns, 1);
});

test("Codex generation terminal観測は同一durable turnのterminalだけをraw handleなしでreceipt化する", async (t) => {
  const root = await stateRoot(t);
  const session = new FakeSession(async (method) => {
    if (method === "thread/start") return threadResult();
    if (method === "turn/start") return { turn: { id: TURN_ID, status: "inProgress", items: [] } };
    if (method === "thread/read") return { thread: { id: THREAD_ID, cwd: ROOT, turns: [{ id: TURN_ID, status: "completed", items: [] }] } };
    throw new Error(`unexpected ${method}`);
  });
  await initialize(session);
  const spawned = await spawnCodexGenerationObserverThread({
    stateRoot: root, request: launchRequest(), session, generationId: GENERATION_ID,
  }, { now: () => NOW });
  await activateCodexGenerationObserver({
    stateRoot: root, request: launchRequest(), spawnResult: spawned, session, generationId: GENERATION_ID,
  }, { now: () => NOW });

  const observed = await observeCodexGenerationTerminal({
    stateRoot: root, request: launchRequest(), session, generationId: GENERATION_ID,
  }, { now: () => NOW });

  assert.deepEqual(observed, {
    schema: "observer.codex_generation_terminal_result.v1",
    provider: "codex",
    watch_id: WATCH_ID,
    target_id: TARGET_ID,
    generation_id: GENERATION_ID,
    outcome: "terminal",
    reason: null,
    receipt: {
      schema: "observer.codex_generation_terminal_receipt.v1",
      provider: "codex",
      watch_id: WATCH_ID,
      target_id: TARGET_ID,
      generation_id: GENERATION_ID,
      terminal_status: "completed",
      observed_at: NOW,
    },
  });
  assert.doesNotMatch(JSON.stringify(observed), new RegExp(`${THREAD_ID}|${TURN_ID}`));
  assert.deepEqual(session.calls.map((entry) => entry[1]).filter(Boolean), ["initialize", "initialized", "thread/start", "turn/start", "thread/read"]);
});

test("Codex generation terminal観測はinProgressをpendingとして返し、別turnやjournal欠損へfallbackしない", async (t) => {
  const root = await stateRoot(t);
  let reads = 0;
  const session = new FakeSession(async (method) => {
    if (method === "thread/start") return threadResult();
    if (method === "turn/start") return { turn: { id: TURN_ID, status: "inProgress", items: [] } };
    if (method === "thread/read") {
      reads += 1;
      return { thread: { id: THREAD_ID, cwd: ROOT, turns: [{ id: reads === 1 ? TURN_ID : OTHER_TURN_ID, status: "inProgress", items: [] }] } };
    }
    throw new Error(`unexpected ${method}`);
  });
  await initialize(session);
  const missing = await observeCodexGenerationTerminal({
    stateRoot: root, request: launchRequest(), session, generationId: GENERATION_ID,
  });
  assert.equal(missing.outcome, "unknown");
  assert.equal(missing.reason, "journal_missing");

  const spawned = await spawnCodexGenerationObserverThread({
    stateRoot: root, request: launchRequest(), session, generationId: GENERATION_ID,
  }, { now: () => NOW });
  await activateCodexGenerationObserver({
    stateRoot: root, request: launchRequest(), spawnResult: spawned, session, generationId: GENERATION_ID,
  }, { now: () => NOW });
  const pending = await observeCodexGenerationTerminal({
    stateRoot: root, request: launchRequest(), session, generationId: GENERATION_ID,
  }, { now: () => NOW });
  assert.equal(pending.outcome, "pending");
  assert.equal(pending.reason, "turn_in_progress");
  const mismatched = await observeCodexGenerationTerminal({
    stateRoot: root, request: launchRequest(), session, generationId: GENERATION_ID,
  }, { now: () => NOW });
  assert.equal(mismatched.outcome, "unknown");
  assert.equal(mismatched.reason, "durable_turn_missing");
  assert.deepEqual(session.calls.map((entry) => entry[1]).filter(Boolean), ["initialize", "initialized", "thread/start", "turn/start", "thread/read", "thread/read"]);
});
