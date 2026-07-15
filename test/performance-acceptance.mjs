import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { claimCurrentParentMessage } from "../src/mailbox-consumer.mjs";
import { hashParentThreadId } from "../src/mailbox-routing.mjs";
import { ObserverError } from "../src/observer-error.mjs";
import { runParentStopHook } from "../src/parent-stop-hook.mjs";
import { createThroughlineClient } from "../src/throughline-client.mjs";

const HOOK = new URL("../bin/observer-parent-stop-hook.mjs", import.meta.url).pathname;
const PROJECT = "/observer-performance-project";
const THREAD = "observer-performance-thread";
const TARGET_ID = `p_${"a".repeat(64)}`;
const WATCH_ID = "w_11111111-1111-4111-8111-111111111111";
const CURSOR = "tlc1.performance";
const WAIT_MS = 50;
const THRESHOLDS = Object.freeze({
  hookProcess: { p95: 250, max: 750 },
  emptyMailbox: { p95: 50, max: 250 },
  waitOverhead: { p95: 250, max: 750 },
});

let fixtureRoot = null;
try {
  requireEnvironment();
  fixtureRoot = await mkdtemp(join(tmpdir(), "observer-performance-"));
  const stateRoot = join(fixtureRoot, "state");
  const throughline = join(fixtureRoot, "throughline-fixture.mjs");
  await writeThroughlineFixture(throughline);

  const hookProcess = await measure(20, 3, () => measureHookProcess(stateRoot));
  const emptyMailbox = await measure(50, 5, () => measureEmptyMailbox(stateRoot));
  const waitElapsed = await measure(10, 3, () => measureWait(throughline));
  const waitOverhead = waitElapsed.map((elapsed) => Math.max(0, elapsed - WAIT_MS));

  const result = {
    schema: "observer.performance_acceptance.v1",
    status: "accepted",
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
    },
    samples: {
      hook_process: summarize(hookProcess, THRESHOLDS.hookProcess),
      empty_mailbox_core: summarize(emptyMailbox, THRESHOLDS.emptyMailbox),
      bounded_wait_overhead: {
        ...summarize(waitOverhead, THRESHOLDS.waitOverhead),
        simulated_wait_ms: WAIT_MS,
      },
    },
  };
  await rm(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = null;
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  let code = error instanceof ObserverError ? error.code : "E_PERFORMANCE_FIXTURE_FAILED";
  if (fixtureRoot !== null) {
    try {
      await rm(fixtureRoot, { recursive: true, force: true });
    } catch {
      code = "E_PERFORMANCE_FIXTURE_CLEANUP_FAILED";
    }
  }
  process.stderr.write(`Observer performance fixture failed: ${code}\n`);
  process.exitCode = 1;
}

function requireEnvironment() {
  if (process.platform !== "darwin") throw new ObserverError("E_PERFORMANCE_PLATFORM_UNSUPPORTED", "unsupported");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new ObserverError("E_PERFORMANCE_NODE_UNSUPPORTED", "unsupported");
  }
}

async function measure(iterations, warmups, operation) {
  for (let index = 0; index < warmups; index += 1) await operation();
  const samples = [];
  for (let index = 0; index < iterations; index += 1) samples.push(await operation());
  return samples;
}

function measureHookProcess(stateRoot) {
  const payload = {
    session_id: THREAD,
    cwd: PROJECT,
    hook_event_name: "Stop",
    stop_hook_active: true,
    turn_id: "performance-turn",
  };
  const started = performance.now();
  const outcome = spawnSync(HOOK, ["--provider", "codex", "--state-root", stateRoot], {
    encoding: "utf8",
    input: JSON.stringify(payload),
  });
  const elapsed = performance.now() - started;
  if (outcome.status !== 0 || outcome.signal !== null || outcome.stdout !== "" || outcome.stderr !== "") {
    throw new ObserverError("E_PERFORMANCE_HOOK_WIRE", "hook wire mismatch");
  }
  return elapsed;
}

async function measureEmptyMailbox(stateRoot) {
  const route = {
    schema: "observer.mailbox_route.v1",
    status: "current",
    target_id: TARGET_ID,
    project_root: PROJECT,
    provider: "codex",
    thread_sha256: hashParentThreadId(THREAD),
    watch_id: WATCH_ID,
    parent_cursor: CURSOR,
  };
  const started = performance.now();
  const result = await runParentStopHook({
    provider: "codex",
    payload: {
      session_id: THREAD,
      cwd: PROJECT,
      hook_event_name: "Stop",
      stop_hook_active: false,
      turn_id: "performance-turn",
    },
    stateRoot,
  }, {
    claimCurrentParentMessage: (input) => claimCurrentParentMessage(input, { resolveRoute: async () => route }),
    emitHookOutput: async () => { throw new ObserverError("E_PERFORMANCE_UNEXPECTED_OUTPUT", "unexpected output"); },
  });
  const elapsed = performance.now() - started;
  if (result.status !== "no_message" || result.route_status !== "current" || result.stale_receipt_count !== 0) {
    throw new ObserverError("E_PERFORMANCE_EMPTY_MAILBOX_WIRE", "empty mailbox mismatch");
  }
  return elapsed;
}

async function measureWait(command) {
  const client = createThroughlineClient({ command });
  const started = performance.now();
  const result = await client.wait({ projectPath: PROJECT, afterCursor: CURSOR, timeoutSeconds: 1 });
  const elapsed = performance.now() - started;
  if (result.status !== "timeout" || result.afterCursor !== CURSOR || result.throughCursor !== CURSOR) {
    throw new ObserverError("E_PERFORMANCE_WAIT_WIRE", "wait wire mismatch");
  }
  return elapsed;
}

function summarize(samples, threshold) {
  const sorted = [...samples].sort((left, right) => left - right);
  const summary = {
    iterations: sorted.length,
    p50_ms: round(percentile(sorted, 0.50)),
    p95_ms: round(percentile(sorted, 0.95)),
    max_ms: round(sorted.at(-1)),
    threshold_p95_ms: threshold.p95,
    threshold_max_ms: threshold.max,
  };
  if (summary.p95_ms > threshold.p95 || summary.max_ms > threshold.max) {
    throw new ObserverError("E_PERFORMANCE_THRESHOLD_EXCEEDED", "threshold exceeded");
  }
  return summary;
}

function percentile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

async function writeThroughlineFixture(path) {
  await writeFile(path, `#!/usr/bin/env node
const args = process.argv.slice(2);
const index = args.indexOf("--after-cursor");
if (args[0] !== "observer-wait" || index < 0 || args.at(-1) !== "--json") process.exit(2);
const afterCursor = args[index + 1];
setTimeout(() => process.stdout.write(JSON.stringify({
  schema: "throughline.observer_wait.v1",
  status: "timeout",
  afterCursor,
  throughCursor: afterCursor,
}) + "\\n"), ${WAIT_MS});
`, { mode: 0o700 });
  await chmod(path, 0o700);
}
