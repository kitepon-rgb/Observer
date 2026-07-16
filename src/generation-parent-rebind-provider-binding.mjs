import * as claudeRuntime from "./claude-host-runtime.mjs";
import * as codexRuntime from "./codex-host-runtime.mjs";
import * as aitermClaudeRuntime from "./aiterm-claude-host-runtime.mjs";
import * as rebind from "./generation-parent-rebind.mjs";
import { buildGenerationLaunchRequest } from "./parent-launch.mjs";
import { fail } from "./observer-error.mjs";

export const GENERATION_PARENT_REBIND_PROVIDER_BINDING_RESULT_SCHEMA =
  "observer.generation_parent_rebind_provider_binding_result.v1";

// parent rebind用のprovider dispatcher。planned rolloverのjournal/APIには触れず、
// providerの生値はこのcall内に閉じ込めて、公開結果へ出さない。
export async function advanceGenerationParentRebindProviderBinding({
  stateRoot,
  target,
  watchId,
  authorization,
  launchRequest,
  oldVerification = null,
  oldSession = null,
  newVerification = null,
  newSession = null,
} = {}, dependencies = {}) {
  requireInput({ stateRoot, target, watchId, authorization, launchRequest });
  const core = dependencies.rebind ?? rebind;
  const providers = {
    claude: dependencies.claudeRuntime ?? claudeRuntime,
    codex: dependencies.codexRuntime ?? codexRuntime,
    aitermClaude: dependencies.aitermClaudeRuntime ?? aitermClaudeRuntime,
  };
  const providerDependencies = dependencies.providerDependencies ?? {};
  const status = await core.readGenerationParentRebindRecoveryContext({
    stateRoot, targetId: target.targetId, watchId, authorization, launchRequest,
  });
  requireStatus(status, target.targetId, watchId, launchRequest.provider);

  switch (status.action) {
    case "authorize_stop":
    case "observe_terminal": {
      const oldRuntime = runtimeFor(status.from_provider, oldVerification, oldSession);
      // cross-providerでもnew launch requestを旧hostへ流用しない。
      const oldRequest = (dependencies.buildGenerationLaunchRequest ?? buildGenerationLaunchRequest)({
        target,
        watchId,
        provider: status.from_provider,
        runtimeRoot: launchRequest.runtime_root,
      });
      return advanceStop({
        status, core, providers, providerDependencies, stateRoot, targetId: target.targetId, watchId,
        oldRequest, oldRuntime,
      });
    }
    case "authorize_start": {
      const newRuntime = runtimeFor(status.to_provider, newVerification, newSession);
      return authorizeStart({
        status, core, providers, providerDependencies, stateRoot, target, watchId, authorization,
        launchRequest, newRuntime,
      });
    }
    case "recover_spawn": {
      const newRuntime = runtimeFor(status.to_provider, newVerification, newSession);
      return recoverSpawn({
        status, core, providers, providerDependencies, stateRoot, targetId: target.targetId, watchId,
        launchRequest, newRuntime,
      });
    }
    case "recover_ready": {
      const newRuntime = runtimeFor(status.to_provider, newVerification, newSession);
      return recoverReady({
        status, core, providers, providerDependencies, stateRoot, targetId: target.targetId, watchId,
        launchRequest, newRuntime,
      });
    }
    case "finish_activation": {
      const newRuntime = runtimeFor(status.to_provider, newVerification, newSession);
      return recoverReady({
        status, core, providers, providerDependencies, stateRoot, targetId: target.targetId, watchId,
        launchRequest, newRuntime,
      });
    }
    default:
      fail("E_PARENT_REBIND_PROVIDER_ACTION_INVALID", "parent rebind provider actionが不正です");
  }
}

async function advanceStop({ status, core, providers, providerDependencies, stateRoot, targetId, watchId, oldRequest, oldRuntime }) {
  const prepared = await core.prepareGenerationParentRebindStop({ stateRoot, targetId, watchId });
  requirePrepared(prepared, status);
  let terminalReceipt = null;
  let stopCommandReceipt = null;
  if (status.from_provider === "claude") {
    if (oldRuntime.mode === "aiterm") {
      const closed = await providers.aitermClaude.stopAitermClaudeObserver({
        stateRoot,
        request: prepared.stop_request,
        transport: oldRuntime.session,
      }, providerDependencies.aitermClaude);
      terminalReceipt = closed.terminal_receipt;
      stopCommandReceipt = closed.stop_command_receipt;
    } else {
      const observed = await providers.claude.observeClaudeObserver({
        request: oldRequest,
        receipt: spawnedReceipt(oldRequest, prepared.stop_request.handle),
        verification: oldRuntime.verification,
      }, providerDependencies.claude);
      if (observed.observation === null) return result(status, "pending", "terminal_not_observed");
      if (["done", "stopped", "failed"].includes(observed.observation.state)) {
        terminalReceipt = stoppedReceipt(oldRequest, prepared.stop_request.handle);
      } else if (prepared.action === "issue_once") {
        await providers.claude.stopClaudeObserver({
          request: prepared.stop_request, observation: observed.observation, verification: oldRuntime.verification,
        }, providerDependencies.claude);
        return result(status, "progressed", "stop_issued");
      } else return result(status, "pending", "terminal_not_observed");
    }
  } else {
    const stopped = await providers.codex.stopCodexObserver({
      stateRoot, request: prepared.stop_request, launchRequest: oldRequest, session: oldRuntime.session,
      generationId: status.from_generation_id,
    }, providerDependencies.codex);
    if (stopped.terminal_receipt === null) {
      return result(status, prepared.action === "issue_once" ? "progressed" : "pending", "terminal_not_observed");
    }
    terminalReceipt = stopped.terminal_receipt;
  }
  await core.confirmGenerationParentRebindTerminal({ stateRoot, targetId, watchId, terminalReceipt, stopCommandReceipt });
  return result(status, "progressed", "terminal_recorded", "terminal_observed");
}

async function authorizeStart({ status, core, providers, providerDependencies, stateRoot, target, watchId, authorization, launchRequest, newRuntime }) {
  const authorized = await core.authorizeReboundGenerationStart({ stateRoot, target, watchId, authorization, launchRequest });
  if (authorized.outcome !== "issue_once") return result(status, "unknown", "authorization_not_issued");
  if (status.to_provider === "claude") {
    if (newRuntime.mode === "aiterm") {
      await providers.aitermClaude.spawnAitermClaudeObserver({
        stateRoot,
        request: launchRequest,
        transport: newRuntime.session,
      }, providerDependencies.aitermClaude);
    } else {
      await providers.claude.spawnClaudeObserver({ request: launchRequest, verification: newRuntime.verification }, providerDependencies.claude);
    }
  } else {
    await providers.codex.spawnCodexGenerationObserverThread({
      stateRoot, request: launchRequest, session: newRuntime.session, generationId: authorized.generation_id,
    }, providerDependencies.codex);
  }
  return result(status, "progressed", "spawn_issued", "spawn_authorized");
}

async function recoverSpawn({ status, core, providers, providerDependencies, stateRoot, targetId, watchId, launchRequest, newRuntime }) {
  const spawn = await recoverSpawnReceipt({ status, providers, providerDependencies, stateRoot, launchRequest, newRuntime });
  if (spawn.receipt === null) return result(status, spawn.outcome, spawn.reason);
  // Codexではこの耐久化/CASがturn/startより先。turn/startが不明でも次回はready回収だけを行う。
  await core.recordReboundGenerationSpawn({ stateRoot, targetId, watchId, spawnReceipt: spawn.receipt });
  return result(status, "progressed", "spawn_recorded", "spawn_observed");
}

async function recoverReady({ status, core, providers, providerDependencies, stateRoot, targetId, watchId, launchRequest, newRuntime }) {
  let readyReceipt;
  if (status.to_provider === "claude") {
    if (newRuntime.mode === "aiterm") {
      const spawn = await providers.aitermClaude.recoverAitermClaudeSpawn({
        stateRoot,
        request: launchRequest,
        transport: newRuntime.session,
      }, providerDependencies.aitermClaude);
      if (spawn.receipt === null) return result(status, "unknown", spawn.reason ?? "provider_spawn_unavailable");
      readyReceipt = (await providers.aitermClaude.activateAitermClaudeGeneration({
        stateRoot,
        request: launchRequest,
        receipt: spawn.receipt,
      }, providerDependencies.aitermClaude)).ready_receipt;
    } else {
      const spawn = await providers.claude.recoverClaudeSpawn({ request: launchRequest, verification: newRuntime.verification }, providerDependencies.claude);
      if (spawn.receipt === null) return result(status, "unknown", "provider_spawn_unavailable");
      const observed = await providers.claude.observeClaudeObserver({ request: launchRequest, receipt: spawn.receipt, verification: newRuntime.verification }, providerDependencies.claude);
      if (observed.ready_receipt === null) return result(status, "pending", "provider_ready_pending");
      readyReceipt = observed.ready_receipt;
    }
  } else {
    const recovered = await providers.codex.recoverCodexGenerationReady({
      stateRoot, request: launchRequest, session: newRuntime.session, generationId: status.to_generation_id,
    }, providerDependencies.codex);
    if (recovered.outcome === "ready" && recovered.receipt !== null) readyReceipt = recovered.receipt;
    else if (recovered.outcome === "unknown" && recovered.reason === "thread_created") {
      const spawn = await providers.codex.recoverCodexGenerationSpawn({ stateRoot, request: launchRequest, generationId: status.to_generation_id }, providerDependencies.codex);
      if (spawn.outcome !== "spawned" || spawn.receipt === null) return result(status, "unknown", spawn.reason ?? "provider_spawn_unavailable");
      const activated = await providers.codex.activateCodexGenerationObserver({
        stateRoot, request: launchRequest, spawnResult: { receipt: spawn.receipt }, session: newRuntime.session,
        generationId: status.to_generation_id,
      }, providerDependencies.codex);
      readyReceipt = activated.ready_receipt;
    } else return result(status, recovered.outcome === "unknown" ? "unknown" : "pending", recovered.reason ?? "provider_ready_pending");
  }
  await core.activateReboundGeneration({ stateRoot, targetId, watchId, readyReceipt });
  return result(status, "activated", "provider_ready_recovered", "active");
}

async function recoverSpawnReceipt({ status, providers, providerDependencies, stateRoot, launchRequest, newRuntime }) {
  if (status.to_provider === "claude") {
    const recovered = newRuntime.mode === "aiterm"
      ? await providers.aitermClaude.recoverAitermClaudeSpawn({
          stateRoot,
          request: launchRequest,
          transport: newRuntime.session,
        }, providerDependencies.aitermClaude)
      : await providers.claude.recoverClaudeSpawn({ request: launchRequest, verification: newRuntime.verification }, providerDependencies.claude);
    return recovered.receipt === null
      ? { receipt: null, outcome: "unknown", reason: "provider_spawn_unavailable" }
      : { receipt: recovered.receipt, outcome: "progressed", reason: null };
  }
  const recovered = await providers.codex.recoverCodexGenerationSpawn({ stateRoot, request: launchRequest, generationId: status.to_generation_id }, providerDependencies.codex);
  return recovered.outcome !== "spawned" || recovered.receipt === null
    ? { receipt: null, outcome: "unknown", reason: recovered.reason ?? "provider_spawn_unavailable" }
    : { receipt: recovered.receipt, outcome: "progressed", reason: null };
}

function runtimeFor(provider, verification, session) {
  if (provider === "claude") {
    if (verification !== null && session === null) return { mode: "background", verification, session: null };
    if (verification === null && session !== null) return { mode: "aiterm", verification: null, session };
    fail("E_PARENT_REBIND_PROVIDER_RUNTIME_INVALID", "Claudeにはbackground verificationまたはAiterm sessionの一方だけが必要です");
  }
  if (provider === "codex") {
    if (verification !== null || session === null) fail("E_PARENT_REBIND_PROVIDER_RUNTIME_INVALID", "Codexにはsessionだけが必要です");
    return { mode: "codex", verification: null, session };
  }
  fail("E_PARENT_REBIND_PROVIDER_UNSUPPORTED", "providerが不正です");
}

function requireInput({ stateRoot, target, watchId, authorization, launchRequest }) {
  if (typeof stateRoot !== "string" || target === null || typeof target !== "object" || typeof target.targetId !== "string" ||
      typeof target.projectRoot !== "string" || typeof watchId !== "string" || authorization === null || typeof authorization !== "object" ||
      launchRequest === null || typeof launchRequest !== "object") {
    fail("E_PARENT_REBIND_PROVIDER_INPUT_INVALID", "parent rebind provider binding inputが不正です");
  }
}

function requireStatus(status, targetId, watchId, launchProvider) {
  const keys = ["action", "from_generation_id", "from_parent_epoch_id", "from_provider", "schema", "status", "target_id", "to_generation_id", "to_parent_epoch_id", "to_provider", "watch_id"];
  const actual = status !== null && typeof status === "object" ? Object.keys(status).sort() : [];
  const actions = {
    rebind_required: "authorize_stop", stop_authorized: "observe_terminal", terminal_observed: "authorize_start",
    spawn_authorized: "recover_spawn", spawn_observed: "recover_ready", ready_observed: "finish_activation",
  };
  if (status === null || typeof status !== "object" || actual.length !== keys.length || actual.some((key, index) => key !== [...keys].sort()[index]) ||
      status.schema !== "observer.generation_parent_rebind_status.v1" || status.target_id !== targetId || status.watch_id !== watchId ||
      !["claude", "codex"].includes(status.from_provider) || !["claude", "codex"].includes(status.to_provider) ||
      status.to_provider !== launchProvider || actions[status.status] !== status.action || !/^sha256:[a-f0-9]{64}$/.test(status.from_generation_id) ||
      !/^sha256:[a-f0-9]{64}$/.test(status.from_parent_epoch_id) || !/^sha256:[a-f0-9]{64}$/.test(status.to_parent_epoch_id) ||
      !(status.to_generation_id === null || /^sha256:[a-f0-9]{64}$/.test(status.to_generation_id))) {
    fail("E_PARENT_REBIND_PROVIDER_STATUS_INVALID", "parent rebind statusとlaunch requestが一致しません");
  }
}

function requirePrepared(prepared, status) {
  if (prepared === null || typeof prepared !== "object" || !["issue_once", "observe_only"].includes(prepared.outcome) ||
      prepared.from_provider !== status.from_provider || prepared.stop_request === null || typeof prepared.stop_request !== "object") {
    fail("E_PARENT_REBIND_PROVIDER_PREPARE_INVALID", "parent rebind stop authorizationが不正です");
  }
}

function spawnedReceipt(request, handle) {
  return { schema: "observer.host_receipt.v1", provider: request.provider, watch_id: request.watch_id, target_id: request.target_id, outcome: "spawned", handle: structuredClone(handle) };
}

function stoppedReceipt(request, handle) {
  return { schema: "observer.host_receipt.v1", provider: request.provider, watch_id: request.watch_id, target_id: request.target_id, outcome: "stopped", handle: structuredClone(handle) };
}

function result(status, outcome, reason, phase = status.status) {
  return publicResult({ from: status.from_provider, to: status.to_provider }, status.target_id, status.watch_id, phase, outcome, reason);
}

function publicResult(provider, targetId, watchId, phase, outcome, reason) {
  return { schema: GENERATION_PARENT_REBIND_PROVIDER_BINDING_RESULT_SCHEMA, provider, target_id: targetId, watch_id: watchId, phase, outcome, reason };
}
