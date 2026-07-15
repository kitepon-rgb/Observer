import { isAbsolute } from "node:path";

import { initializeCodexObserverSession } from "./codex-host-runtime.mjs";
import {
  startCodexAppServerTransport,
  verifyCodexAppServerRuntime,
} from "./codex-process-transport.mjs";
import { fail } from "./observer-error.mjs";
import { runSupervisorProcess } from "./supervisor-process.mjs";
import {
  createVerifiedThroughlineClient,
  verifyThroughlineRuntime,
} from "./throughline-process-runtime.mjs";

export async function runCodexSupervisorProcess({
  stateRoot,
  target,
  watchId,
  runtimeRoot,
  throughlineCommand,
  codexCommand,
  planRefs = [],
  testReceipts = [],
  timeoutSeconds = 3600,
  pollIntervalMs = 1_000,
  signal,
} = {}, dependencies = {}) {
  if (![runtimeRoot, throughlineCommand, codexCommand].every((value) => typeof value === "string" && isAbsolute(value))) {
    fail("E_SUPERVISOR_CODEX_PROCESS_INPUT_INVALID", "Codex Supervisor processのruntime pathが不正です");
  }
  const throughlineVerification = await (dependencies.verifyThroughlineRuntime ?? verifyThroughlineRuntime)({
    runtimeRoot,
    throughlineCommand,
  }, dependencies.throughlineVerificationDependencies);
  const client = (dependencies.createVerifiedThroughlineClient ?? createVerifiedThroughlineClient)({
    verification: throughlineVerification,
  }, dependencies.throughlineClientDependencies);
  const run = dependencies.runSupervisorProcess ?? runSupervisorProcess;
  return run({
    stateRoot,
    target,
    watchId,
    client,
    createProviderRuntime: () => (dependencies.createCodexSupervisorRuntime ?? createCodexSupervisorRuntime)({
      runtimeRoot,
      codexCommand,
    }, dependencies.codexRuntimeDependencies),
    planRefs,
    testReceipts,
    timeoutSeconds,
    pollIntervalMs,
    signal,
  }, dependencies.processDependencies);
}

export async function createCodexSupervisorRuntime({ runtimeRoot, codexCommand } = {}, dependencies = {}) {
  const verification = await (dependencies.verifyCodexAppServerRuntime ?? verifyCodexAppServerRuntime)({
    runtimeRoot,
    codexCommand,
  }, dependencies.verificationDependencies);
  let transport = null;
  try {
    transport = await (dependencies.startCodexAppServerTransport ?? startCodexAppServerTransport)({ verification }, dependencies.transportDependencies);
    if (!transport || typeof transport.request !== "function" || typeof transport.notify !== "function" ||
        typeof transport.closeAndWait !== "function") {
      fail("E_SUPERVISOR_CODEX_RUNTIME_INVALID", "Codex app-server transport所有権が不正です");
    }
    await (dependencies.initializeCodexObserverSession ?? initializeCodexObserverSession)({ session: transport }, dependencies.initializeDependencies);
    return {
      providerRuntime: {
        provider: "codex",
        runtime_root: verification.runtime_root,
        session: transport,
      },
      close: () => transport.closeAndWait(),
    };
  } catch (error) {
    if (transport !== null && typeof transport.closeAndWait === "function") {
      try {
        await transport.closeAndWait();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Codex Supervisor runtime初期化とcleanupが失敗しました");
      }
    }
    throw error;
  }
}
