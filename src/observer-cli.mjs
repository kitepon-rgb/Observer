import { isAbsolute } from "node:path";

import { ObserverError, fail } from "./observer-error.mjs";
import { runObserverLiveCampaignPreflight } from "./live-campaign-preflight.mjs";
import { defaultStateRoot } from "./private-state.mjs";
import { runObserverProductDiagnostics } from "./product-diagnostics.mjs";
import { readRegisteredProjectTarget, registerProjectTarget } from "./project-target.mjs";
import { runCodexSupervisorProcess } from "./supervisor-codex-process.mjs";
import {
  readObserverWatchStatus,
  startObserverWatch,
  stopObserverWatch,
  validateWatchCommandResult,
} from "./watch-lifecycle.mjs";

const WATCH = /^w_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROCESS_STATUSES = new Set([
  "cancelled", "faulted", "provider_unavailable", "stopping", "stopped",
]);

export function observerUsage() {
  return [
    "usage: observer diagnostics",
    "usage: observer campaign preflight --claude-command <absolute-path> --codex-command <absolute-path>",
    "usage: observer watch <absolute-project-root> [--state-root <absolute-path>]",
    "       observer watch start <absolute-project-root> [--state-root <absolute-path>]",
    "       observer watch status <absolute-project-root> [--state-root <absolute-path>]",
    "       observer watch stop <absolute-project-root> [--state-root <absolute-path>]",
    "       observer target register <absolute-project-root> [--state-root <absolute-path>]",
    "       observer supervisor run <absolute-project-root> --watch-id <id> --runtime-root <absolute-path> --throughline-command <absolute-path> --codex-command <absolute-path> [--state-root <absolute-path>] [--timeout-seconds <1..3600>] [--poll-interval-ms <100..60000>] [--plan-ref <file:relative-path>]...",
  ].join("\n");
}

export function parseObserverArguments(argv) {
  if (!Array.isArray(argv)) fail("E_USAGE", observerUsage());
  if (argv.length === 1 && argv[0] === "diagnostics") return { kind: "diagnostics" };
  if (argv[0] === "campaign" && argv[1] === "preflight") return parseCampaignPreflight(argv);
  if (argv[0] === "watch") return parseWatch(argv);
  if (argv[0] === "target" && argv[1] === "register") return parseTargetRegister(argv);
  if (argv[0] === "supervisor" && argv[1] === "run") return parseSupervisorRun(argv);
  fail("E_USAGE", observerUsage());
}

export async function executeObserverCommand(argv, { signal, parentContext } = {}, dependencies = {}) {
  const command = parseObserverArguments(argv);
  if (command.kind === "diagnostics") {
    const result = await (dependencies.runObserverProductDiagnostics ?? runObserverProductDiagnostics)();
    return { result, exitCode: result.status === "ready" ? 0 : 1 };
  }
  if (command.kind === "campaign_preflight") {
    const result = await (dependencies.runObserverLiveCampaignPreflight ?? runObserverLiveCampaignPreflight)({
      claudeCommand: command.claudeCommand,
      codexCommand: command.codexCommand,
    }, dependencies.preflightDependencies);
    return { result, exitCode: result.status === "blocked" ? 1 : 0 };
  }
  if (command.kind.startsWith("watch_")) {
    const handlers = {
      watch_start: dependencies.startObserverWatch ?? startObserverWatch,
      watch_status: dependencies.readObserverWatchStatus ?? readObserverWatchStatus,
      watch_stop: dependencies.stopObserverWatch ?? stopObserverWatch,
    };
    const result = await handlers[command.kind]({
      stateRoot: command.stateRoot,
      projectRoot: command.projectRoot,
      parentContext,
    }, dependencies.watchDependencies ?? dependencies);
    validateWatchCommandResult(result);
    return { result, exitCode: result.status === "provider_unavailable" ? 1 : 0 };
  }
  if (command.kind === "target_register") {
    const target = await (dependencies.registerProjectTarget ?? registerProjectTarget)({
      stateRoot: command.stateRoot,
      projectRoot: command.projectRoot,
    });
    return {
      result: {
        schema: "observer.cli_result.v1",
        status: target.created ? "created" : "existing",
        target_id: target.targetId,
        project_root: target.projectRoot,
      },
      exitCode: 0,
    };
  }

  const target = await (dependencies.readRegisteredProjectTarget ?? readRegisteredProjectTarget)({
    stateRoot: command.stateRoot,
    projectRoot: command.projectRoot,
  });
  const result = await (dependencies.runCodexSupervisorProcess ?? runCodexSupervisorProcess)({
    stateRoot: command.stateRoot,
    target: {
      schema: target.schema,
      targetId: target.targetId,
      projectRoot: target.projectRoot,
    },
    watchId: command.watchId,
    runtimeRoot: command.runtimeRoot,
    throughlineCommand: command.throughlineCommand,
    codexCommand: command.codexCommand,
    planRefs: command.planRefs,
    testReceipts: [],
    timeoutSeconds: command.timeoutSeconds,
    pollIntervalMs: command.pollIntervalMs,
    signal,
  });
  validateProcessResult(result);
  return { result, exitCode: exitCodeForProcessResult(result.status) };
}

function parseWatch(argv) {
  if (argv.length < 2) fail("E_USAGE", observerUsage());
  const explicitAction = ["start", "status", "stop"].includes(argv[1]);
  const action = explicitAction ? argv[1] : "start";
  const projectIndex = explicitAction ? 2 : 1;
  if (argv.length <= projectIndex) fail("E_USAGE", observerUsage());
  const projectRoot = argv[projectIndex];
  let stateRoot;
  for (let index = projectIndex + 1; index < argv.length; index += 1) {
    if (argv[index] !== "--state-root" || stateRoot !== undefined || index + 1 >= argv.length) {
      fail("E_USAGE", observerUsage());
    }
    stateRoot = argv[index + 1];
    index += 1;
  }
  validateAbsolute(projectRoot, "E_PROJECT_PATH_NOT_ABSOLUTE", "project rootは絶対パスで指定してください");
  if (stateRoot !== undefined) {
    validateAbsolute(stateRoot, "E_PATH_NOT_ABSOLUTE", "state rootは絶対パスで指定してください");
  }
  return { kind: `watch_${action}`, projectRoot, stateRoot: stateRoot ?? defaultStateRoot() };
}

function parseCampaignPreflight(argv) {
  const values = {};
  const flags = new Map([
    ["--claude-command", "claudeCommand"],
    ["--codex-command", "codexCommand"],
  ]);
  for (let index = 2; index < argv.length; index += 1) {
    const key = flags.get(argv[index]);
    if (key === undefined || Object.hasOwn(values, key) || index + 1 >= argv.length) {
      fail("E_USAGE", observerUsage());
    }
    values[key] = argv[index + 1];
    index += 1;
  }
  if (!Object.hasOwn(values, "claudeCommand") || !Object.hasOwn(values, "codexCommand")) {
    fail("E_USAGE", observerUsage());
  }
  validateAbsolute(values.claudeCommand, "E_USAGE", observerUsage());
  validateAbsolute(values.codexCommand, "E_USAGE", observerUsage());
  return { kind: "campaign_preflight", ...values };
}

export function formatObserverCliError(error) {
  const known = error instanceof ObserverError;
  const aggregate = error instanceof AggregateError;
  const code = known ? error.code : aggregate ? "E_SUPERVISOR_PROCESS_CLEANUP_FAILED" : "E_INTERNAL";
  const message = known
    ? error.message
    : aggregate
      ? "Supervisor processまたはcleanupが失敗しました"
      : "Observer commandが失敗しました";
  return {
    result: { schema: "observer.cli_error.v1", code, message },
    exitCode: known && error.code === "E_USAGE" ? 2 : 1,
  };
}

function parseTargetRegister(argv) {
  if (argv.length < 3) fail("E_USAGE", observerUsage());
  const projectRoot = argv[2];
  let stateRoot;
  for (let index = 3; index < argv.length; index += 1) {
    if (argv[index] !== "--state-root" || stateRoot !== undefined || index + 1 >= argv.length) fail("E_USAGE", observerUsage());
    stateRoot = argv[index + 1];
    index += 1;
  }
  validateAbsolute(projectRoot, "E_PROJECT_PATH_NOT_ABSOLUTE", "project rootは絶対パスで指定してください");
  if (stateRoot !== undefined) validateAbsolute(stateRoot, "E_PATH_NOT_ABSOLUTE", "state rootは絶対パスで指定してください");
  return { kind: "target_register", projectRoot, stateRoot: stateRoot ?? defaultStateRoot() };
}

function parseSupervisorRun(argv) {
  if (argv.length < 3) fail("E_USAGE", observerUsage());
  const projectRoot = argv[2];
  validateAbsolute(projectRoot, "E_PROJECT_PATH_NOT_ABSOLUTE", "project rootは絶対パスで指定してください");
  const single = new Map([
    ["--watch-id", "watchId"],
    ["--runtime-root", "runtimeRoot"],
    ["--throughline-command", "throughlineCommand"],
    ["--codex-command", "codexCommand"],
    ["--state-root", "stateRoot"],
    ["--timeout-seconds", "timeoutSeconds"],
    ["--poll-interval-ms", "pollIntervalMs"],
  ]);
  const values = {};
  const planRefs = [];
  for (let index = 3; index < argv.length; index += 1) {
    const flag = argv[index];
    if (index + 1 >= argv.length) fail("E_USAGE", observerUsage());
    const value = argv[index + 1];
    if (flag === "--plan-ref") {
      if (planRefs.length >= 4 || planRefs.includes(value) || !isPlanRef(value)) fail("E_USAGE", observerUsage());
      planRefs.push(value);
      index += 1;
      continue;
    }
    const key = single.get(flag);
    if (key === undefined || Object.hasOwn(values, key)) fail("E_USAGE", observerUsage());
    values[key] = value;
    index += 1;
  }
  for (const key of ["watchId", "runtimeRoot", "throughlineCommand", "codexCommand"]) {
    if (!Object.hasOwn(values, key)) fail("E_USAGE", observerUsage());
  }
  if (!WATCH.test(values.watchId)) fail("E_USAGE", observerUsage());
  for (const key of ["runtimeRoot", "throughlineCommand", "codexCommand"]) {
    validateAbsolute(values[key], "E_USAGE", observerUsage());
  }
  if (values.stateRoot !== undefined) validateAbsolute(values.stateRoot, "E_USAGE", observerUsage());
  const timeoutSeconds = parseBoundedInteger(values.timeoutSeconds, 1, 3600, 3600);
  const pollIntervalMs = parseBoundedInteger(values.pollIntervalMs, 100, 60_000, 1_000);
  return {
    kind: "supervisor_run",
    projectRoot,
    stateRoot: values.stateRoot ?? defaultStateRoot(),
    watchId: values.watchId,
    runtimeRoot: values.runtimeRoot,
    throughlineCommand: values.throughlineCommand,
    codexCommand: values.codexCommand,
    timeoutSeconds,
    pollIntervalMs,
    planRefs,
  };
}

function parseBoundedInteger(value, minimum, maximum, fallback) {
  if (value === undefined) return fallback;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) fail("E_USAGE", observerUsage());
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) fail("E_USAGE", observerUsage());
  return parsed;
}

function validateAbsolute(value, code, message) {
  if (typeof value !== "string" || !isAbsolute(value)) fail(code, message);
}

function isPlanRef(value) {
  if (typeof value !== "string" || !value.startsWith("file:")) return false;
  const relative = value.slice(5);
  if (relative.length === 0 || relative.includes("\\") || relative.startsWith("/") || /^[A-Za-z]:/.test(relative)) return false;
  return relative.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function validateProcessResult(value) {
  if (!isPlainObject(value) || Object.keys(value).sort().join(",") !== "cycle_id,provider,schema,status" ||
      value.schema !== "observer.supervisor_process_result.v1" || !PROCESS_STATUSES.has(value.status) ||
      !["claude", "codex"].includes(value.provider) ||
      (value.cycle_id !== null && (typeof value.cycle_id !== "string" || !/^c_[a-f0-9]{64}$/.test(value.cycle_id)))) {
    fail("E_SUPERVISOR_CLI_RESULT_INVALID", "Supervisor process resultが不正です");
  }
}

function exitCodeForProcessResult(status) {
  if (status === "cancelled") return 130;
  if (status === "faulted" || status === "provider_unavailable") return 1;
  return 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
