import * as claudeRuntime from "./claude-host-runtime.mjs";
import * as codexRuntime from "./codex-host-runtime.mjs";
import * as lifecycle from "./generation-host-lifecycle.mjs";
import { ObserverError, fail } from "./observer-error.mjs";

export const GENERATION_HOST_PROVIDER_BINDING_RESULT_SCHEMA = "observer.generation_host_provider_binding_result.v1";

// 一commandだけを実行するdispatcher。provider receiptは局所変数に留め、
// durableなdigest表現はlifecycleだけが所有する。
export async function advanceGenerationHostProviderRollover({
  stateRoot, targetId, watchId, launchRequest, verification = null, session = null,
} = {}, dependencies = {}) {
  requireInput({ stateRoot, targetId, watchId, launchRequest });
  const core = dependencies.lifecycle ?? lifecycle;
  const providers = {
    claude: dependencies.claudeRuntime ?? claudeRuntime,
    codex: dependencies.codexRuntime ?? codexRuntime,
  };
  const providerDependencies = dependencies.providerDependencies ?? {};

  let context;
  try {
    context = await core.readGenerationHostRecoveryContext({ stateRoot, targetId, watchId, launchRequest });
  } catch (error) {
    if (!(error instanceof ObserverError) || error.code !== "E_GENERATION_HOST_JOURNAL_NOT_FOUND") throw error;
    const prepared = await core.prepareGenerationHostStop({ stateRoot, targetId, watchId });
    return advanceStop({ prepared, core, providers, providerDependencies, stateRoot, targetId, watchId, launchRequest, verification, session });
  }

  if (context.provider !== launchRequest.provider) fail("E_GENERATION_PROVIDER_MISMATCH", "provider bindingとlaunch requestが一致しません");
  switch (context.action) {
    case "observe_terminal": {
      const prepared = await core.prepareGenerationHostStop({ stateRoot, targetId, watchId });
      return advanceStop({ prepared, core, providers, providerDependencies, stateRoot, targetId, watchId, launchRequest, verification, session });
    }
    case "authorize_start": {
      const authorized = await core.authorizeNextGenerationHostStart({ stateRoot, targetId, watchId, launchRequest });
      if (authorized.action !== "issue_once") return result(context, "unknown", "authorization_not_issued");
      return issueSpawn({ context, authorized, providers, providerDependencies, stateRoot, launchRequest, verification, session });
    }
    case "recover_spawn":
      return recoverSpawn({ context, core, providers, providerDependencies, stateRoot, targetId, watchId, launchRequest, verification, session });
    case "recover_ready":
    case "finish_activation":
      return recoverReady({ context, core, providers, providerDependencies, stateRoot, targetId, watchId, launchRequest, verification, session });
    default:
      fail("E_GENERATION_PROVIDER_ACTION_INVALID", "generation recovery actionが不正です");
  }
}

async function advanceStop(args) {
  const { prepared, core, providers, providerDependencies, stateRoot, targetId, watchId, launchRequest, verification, session } = args;
  const provider = launchRequest.provider;
  let stopped;
  if (provider === "claude") {
    const observation = await providers.claude.observeClaudeObserver({
      request: launchRequest, receipt: spawnedReceipt(launchRequest, prepared.stop_request.handle), verification,
    }, providerDependencies.claude);
    if (observation.observation === null) return resultFor(provider, targetId, watchId, "stop_authorized", "pending", "terminal_not_observed");
    if (["done", "stopped", "failed"].includes(observation.observation.state)) {
      stopped = stoppedReceipt(launchRequest, prepared.stop_request.handle);
    } else if (prepared.action === "issue_once") {
      await providers.claude.stopClaudeObserver({ request: prepared.stop_request, observation: observation.observation, verification }, providerDependencies.claude);
      return resultFor(provider, targetId, watchId, "stop_authorized", "progressed", "stop_issued");
    } else return resultFor(provider, targetId, watchId, "stop_authorized", "pending", "terminal_not_observed");
  } else if (provider === "codex") {
    const operation = prepared.action === "issue_once"
      ? await providers.codex.stopCodexObserver({
          stateRoot, request: prepared.stop_request, launchRequest, session, generationId: prepared.from_generation_id,
        }, providerDependencies.codex)
      : await providers.codex.observeCodexGenerationTerminal({ stateRoot, request: launchRequest, session, generationId: prepared.from_generation_id }, providerDependencies.codex);
    if (prepared.action === "observe_only") {
      if (operation.outcome !== "terminal") {
        return resultFor(provider, targetId, watchId, "stop_authorized", operation.outcome, operation.reason ?? "terminal_not_observed");
      }
      const exact = await providers.codex.stopCodexObserver({
        stateRoot,
        request: prepared.stop_request,
        launchRequest,
        session,
        generationId: prepared.from_generation_id,
      }, providerDependencies.codex);
      if (exact.terminal_receipt === null) {
        return resultFor(provider, targetId, watchId, "stop_authorized", "unknown", "terminal_receipt_unavailable");
      }
      stopped = exact.terminal_receipt;
    } else {
      stopped = operation.terminal_receipt;
      if (stopped === null) return resultFor(provider, targetId, watchId, "stop_authorized", "progressed", "terminal_not_observed");
    }
  } else fail("E_GENERATION_PROVIDER_UNSUPPORTED", "providerが不正です");
  await core.confirmGenerationHostTerminal({ stateRoot, targetId, watchId, terminalReceipt: stopped });
  return resultFor(provider, targetId, watchId, "terminal_observed", "progressed", "terminal_recorded");
}

async function issueSpawn({ context, authorized, providers, providerDependencies, stateRoot, launchRequest, verification, session }) {
  if (launchRequest.provider === "claude") {
    await providers.claude.spawnClaudeObserver({ request: launchRequest, verification }, providerDependencies.claude);
  } else if (launchRequest.provider === "codex") {
    await providers.codex.spawnCodexGenerationObserverThread({ stateRoot, request: launchRequest, session, generationId: authorized.generation_id }, providerDependencies.codex);
  } else fail("E_GENERATION_PROVIDER_UNSUPPORTED", "providerが不正です");
  return resultFor(context.provider, context.target_id, context.watch_id, "spawn_authorized", "progressed", "spawn_issued");
}

async function recoverSpawn(args) {
  const { context, core, providers, providerDependencies, stateRoot, targetId, watchId, launchRequest, verification, session } = args;
  let spawn; let ready;
  if (launchRequest.provider === "claude") {
    const recovered = await providers.claude.recoverClaudeSpawn({ request: launchRequest, verification }, providerDependencies.claude);
    if (recovered.receipt === null) return result(context, "unknown", "provider_spawn_unavailable");
    spawn = recovered.receipt;
    const observed = await providers.claude.observeClaudeObserver({ request: launchRequest, receipt: spawn, verification }, providerDependencies.claude);
    ready = observed.ready_receipt;
    if (ready === null) return result(context, "pending", "provider_ready_pending");
  } else if (launchRequest.provider === "codex") {
    const recovered = await providers.codex.recoverCodexGenerationSpawn({ stateRoot, request: launchRequest, generationId: context.to_generation_id }, providerDependencies.codex);
    if (recovered.outcome !== "spawned" || recovered.receipt === null) return result(context, "unknown", recovered.reason ?? "provider_spawn_unavailable");
    spawn = recovered.receipt;
    const activated = await providers.codex.activateCodexGenerationObserver({ stateRoot, request: launchRequest, spawnResult: { receipt: spawn }, session, generationId: context.to_generation_id }, providerDependencies.codex);
    ready = activated.ready_receipt;
  } else fail("E_GENERATION_PROVIDER_UNSUPPORTED", "providerが不正です");
  await core.recordNextGenerationHostSpawn({ stateRoot, targetId, watchId, spawnReceipt: spawn });
  await core.activateNextGenerationHost({ stateRoot, targetId, watchId, readyReceipt: ready });
  return result(context, "activated", "provider_ready_recovered");
}

async function recoverReady(args) {
  const { context, core, providers, providerDependencies, stateRoot, targetId, watchId, launchRequest, verification, session } = args;
  let ready;
  if (launchRequest.provider === "claude") {
    const recovered = await providers.claude.recoverClaudeSpawn({ request: launchRequest, verification }, providerDependencies.claude);
    if (recovered.receipt === null) return result(context, "unknown", "provider_spawn_unavailable");
    ready = (await providers.claude.observeClaudeObserver({ request: launchRequest, receipt: recovered.receipt, verification }, providerDependencies.claude)).ready_receipt;
  } else if (launchRequest.provider === "codex") {
    const recovered = await providers.codex.recoverCodexGenerationReady({ stateRoot, request: launchRequest, session, generationId: context.to_generation_id }, providerDependencies.codex);
    if (recovered.outcome !== "ready" || recovered.receipt === null) return result(context, "unknown", recovered.reason ?? "provider_ready_unavailable");
    ready = recovered.receipt;
  } else fail("E_GENERATION_PROVIDER_UNSUPPORTED", "providerが不正です");
  if (ready === null) return result(context, "pending", "provider_ready_pending");
  await core.activateNextGenerationHost({ stateRoot, targetId, watchId, readyReceipt: ready });
  return result(context, "activated", "provider_ready_recovered");
}

function spawnedReceipt(request, handle) { return { schema: "observer.host_receipt.v1", provider: request.provider, watch_id: request.watch_id, target_id: request.target_id, outcome: "spawned", handle: structuredClone(handle) }; }
function stoppedReceipt(request, handle) { return { schema: "observer.host_receipt.v1", provider: request.provider, watch_id: request.watch_id, target_id: request.target_id, outcome: "stopped", handle: structuredClone(handle) }; }
function result(context, outcome, reason) { return resultFor(context.provider, context.target_id, context.watch_id, context.status, outcome, reason); }
function resultFor(provider, targetId, watchId, phase, outcome, reason) { return { schema: GENERATION_HOST_PROVIDER_BINDING_RESULT_SCHEMA, provider, target_id: targetId, watch_id: watchId, phase, outcome, reason }; }
function requireInput({ stateRoot, targetId, watchId, launchRequest }) { if (typeof stateRoot !== "string" || typeof targetId !== "string" || typeof watchId !== "string" || launchRequest === null || typeof launchRequest !== "object") fail("E_GENERATION_PROVIDER_INPUT_INVALID", "provider binding inputが不正です"); }
