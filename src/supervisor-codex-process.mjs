import { isAbsolute } from "node:path";

import { initializeCodexObserverSession } from "./codex-host-runtime.mjs";
import { readCycleState } from "./cycle-store.mjs";
import {
  startCodexAppServerTransport,
  verifyCodexAppServerRuntime,
} from "./codex-process-transport.mjs";
import { advanceGenerationHostProviderRollover } from "./generation-host-provider-binding.mjs";
import {
  authorizeGenerationParentRebind,
} from "./generation-parent-rebind.mjs";
import { advanceGenerationParentRebindProviderBinding } from "./generation-parent-rebind-provider-binding.mjs";
import { fail } from "./observer-error.mjs";
import { buildGenerationLaunchRequest } from "./parent-launch.mjs";
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
      stateRoot,
      target,
      watchId,
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

export async function createCodexSupervisorRuntime({ stateRoot, target, watchId, runtimeRoot, codexCommand } = {}, dependencies = {}) {
  const launchRequest = (dependencies.buildGenerationLaunchRequest ?? buildGenerationLaunchRequest)({
    target, watchId, provider: "codex", runtimeRoot,
  });
  const verification = await (dependencies.verifyCodexAppServerRuntime ?? verifyCodexAppServerRuntime)({
    runtimeRoot,
    codexCommand,
  }, dependencies.verificationDependencies);
  let transport = null;
  try {
    transport = await (dependencies.startCodexAppServerTransport ?? startCodexAppServerTransport)({ verification }, dependencies.transportDependencies);
    if (!transport || typeof transport.request !== "function" || typeof transport.notify !== "function" ||
        typeof transport.closeAndWait !== "function" || !(transport.terminationSignal instanceof AbortSignal)) {
      fail("E_SUPERVISOR_CODEX_RUNTIME_INVALID", "Codex app-server transport所有権が不正です");
    }
    await (dependencies.initializeCodexObserverSession ?? initializeCodexObserverSession)({ session: transport }, dependencies.initializeDependencies);
    const prepareGenerationParentRebind = async ({ cycleId, proposedParent } = {}) => {
      if (proposedParent?.host !== "codex") {
        fail("E_SUPERVISOR_CODEX_REBIND_PROVIDER_UNAVAILABLE", "Codex runtimeはcross-provider rebindをまだ実行できません");
      }
      return (dependencies.authorizeGenerationParentRebind ?? authorizeGenerationParentRebind)({
        stateRoot,
        target,
        watchId,
        cycleId,
        proposedParent,
      }, dependencies.parentRebindDependencies);
    };
    return {
      providerRuntime: {
        provider: "codex",
        runtime_root: verification.runtime_root,
        session: transport,
      },
      providerSignal: transport.terminationSignal,
      advanceGenerationRollover: () => (
        dependencies.advanceGenerationHostProviderRollover ?? advanceGenerationHostProviderRollover
      )({
        stateRoot,
        targetId: target.targetId,
        watchId,
        launchRequest,
        session: transport,
      }, dependencies.rolloverDependencies),
      prepareGenerationParentRebind,
      advanceGenerationParentRebind: async () => {
        const cycle = await (dependencies.readCycleState ?? readCycleState)({ stateRoot, targetId: target.targetId });
        const pending = cycle?.pending_cycle;
        if (!pending || pending.status !== "prepared" || pending.proposed_state?.host !== "codex") {
          fail("E_SUPERVISOR_CODEX_REBIND_CYCLE_INVALID", "Codex parent rebindにprepared cycleが必要です");
        }
        const authorized = await prepareGenerationParentRebind({
          cycleId: pending.cycle_id,
          proposedParent: pending.proposed_state,
        });
        return (dependencies.advanceGenerationParentRebindProviderBinding ?? advanceGenerationParentRebindProviderBinding)({
          stateRoot,
          target,
          watchId,
          authorization: authorized.authorization,
          launchRequest,
          oldSession: transport,
          newSession: transport,
        }, dependencies.parentRebindBindingDependencies);
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
