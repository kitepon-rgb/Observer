import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

import {
  activateGeneration,
  authorizeGenerationRebind,
  beginReboundGeneration,
  confirmGenerationTerminal,
  generationParentEpochId,
  readGenerationState,
  requestGenerationRebindStop,
} from "./generation-store.mjs";
import { fail, ObserverError } from "./observer-error.mjs";
import {
  validateParentHostReceipt,
  validateParentLaunchRequest,
  validateParentStopRequest,
} from "./parent-launch.mjs";
import {
  acquirePrivateLock,
  assertPrivateDirectory,
  assertWithin,
  atomicCreatePrivateFile,
  atomicReplacePrivateFile,
  readPrivateJson,
  removePrivateFile,
} from "./private-state.mjs";
import {
  compareAndSwapWatchHostBinding,
  readWatchHostBinding,
} from "./watch-store.mjs";

export const GENERATION_PARENT_REBIND_SCHEMA = "observer.generation_parent_rebind.v1";
export const PARENT_REBIND_AUTHORIZATION_SCHEMA = "observer.parent_rebind_authorization.v1";
export const GENERATION_PARENT_REBIND_RESULT_SCHEMA = "observer.generation_parent_rebind_result.v1";
export const GENERATION_PARENT_REBIND_STATUS_SCHEMA = "observer.generation_parent_rebind_status.v1";

const TARGET = /^p_[a-f0-9]{64}$/;
const WATCH = /^w_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CYCLE = /^c_[a-f0-9]{64}$/;
const HEX = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const STATUSES = new Set(["rebind_required", "stop_authorized", "terminal_observed", "spawn_authorized", "spawn_observed", "ready_observed"]);
const ACTIONS = Object.freeze({
  rebind_required: "authorize_stop",
  stop_authorized: "observe_terminal",
  terminal_observed: "authorize_start",
  spawn_authorized: "recover_spawn",
  spawn_observed: "recover_ready",
  ready_observed: "finish_activation",
});
const JOURNAL_KEYS = Object.freeze([
  "authorization_digest", "created_at", "from_generation_id", "from_parent_epoch_id", "from_provider",
  "launch_request_digest", "next_handle_digest", "previous_handle_digest", "ready_receipt_digest", "schema",
  "spawn_receipt_digest", "status", "stop_command_receipt_digest", "target_id", "terminal_receipt_digest", "to_generation_id",
  "to_parent_epoch_id", "to_provider", "updated_at", "watch_id",
]);
const LEGACY_JOURNAL_KEYS = Object.freeze(JOURNAL_KEYS.filter((key) => key !== "stop_command_receipt_digest"));
const AUTHORIZATION_KEYS = Object.freeze([
  "cycle_id", "from_generation_id", "from_parent_epoch_id", "from_provider", "schema", "target_id",
  "through_cursor_sha256", "to_parent_epoch_id", "to_parent_thread_sha256", "to_provider", "watch_id",
]);

export async function authorizeGenerationParentRebind({ stateRoot, target, watchId, cycleId, proposedParent } = {}, dependencies = {}) {
  validateTarget(target); validateWatchId(watchId); validateCycleId(cycleId); validateProposedParent(proposedParent, target);
  return withRebindLock(stateRoot, target.targetId, async (paths) => {
    const existing = await readJournal(paths.journalPath);
    if (existing !== null) {
      requireJournalIdentity(existing, target.targetId, watchId);
      const authorization = buildAuthorizationFromJournal({ journal: existing, target, cycleId, proposedParent });
      if (existing.authorization_digest !== digestValue(authorization) ||
          existing.to_parent_epoch_id !== authorization.to_parent_epoch_id ||
          existing.to_provider !== authorization.to_provider) {
        fail("E_PARENT_REBIND_AUTHORIZATION_CONFLICT", "rebind authorizationが記録済みdigestと一致しません");
      }
      return { schema: GENERATION_PARENT_REBIND_RESULT_SCHEMA, outcome: "existing", authorization: structuredClone(authorization) };
    }
    const generation = await (dependencies.readGenerationState ?? readGenerationState)({ stateRoot, targetId: target.targetId });
    const binding = await readBinding({ stateRoot, targetId: target.targetId, watchId }, dependencies);
    requireCurrentIdentity(generation, binding, { target, watchId });
    const authorization = buildAuthorization({ generation, target, watchId, cycleId, proposedParent });
    if (authorization.to_parent_epoch_id === generation.parent_epoch_id) {
      fail("E_PARENT_REBIND_EPOCH_UNCHANGED", "current parent epochはrebind対象ではありません");
    }
    const journal = validateJournal({
      schema: GENERATION_PARENT_REBIND_SCHEMA,
      target_id: target.targetId,
      watch_id: watchId,
      from_provider: generation.provider,
      to_provider: proposedParent.host,
      from_parent_epoch_id: generation.parent_epoch_id,
      to_parent_epoch_id: authorization.to_parent_epoch_id,
      from_generation_id: generation.generation_id,
      to_generation_id: null,
      status: "rebind_required",
      authorization_digest: digestValue(authorization),
      previous_handle_digest: digestValue(binding.launch_handle),
      stop_command_receipt_digest: null,
      terminal_receipt_digest: null,
      launch_request_digest: null,
      spawn_receipt_digest: null,
      next_handle_digest: null,
      ready_receipt_digest: null,
      created_at: timestamp(dependencies.now),
      updated_at: timestamp(dependencies.now),
    });
    await atomicCreatePrivateFile(paths.journalPath, serialize(journal));
    const authorized = await (dependencies.authorizeGenerationRebind ?? authorizeGenerationRebind)({
      stateRoot, targetId: target.targetId, watchId, expectedGenerationId: journal.from_generation_id,
    }, generationDependencies(dependencies));
    if (authorized.status !== "rebind_required" || authorized.generation_id !== journal.from_generation_id) {
      fail("E_PARENT_REBIND_GENERATION_MISMATCH", "generation rebind authorizationを確認できません");
    }
    return { schema: GENERATION_PARENT_REBIND_RESULT_SCHEMA, outcome: "recorded", authorization: structuredClone(authorization) };
  });
}

export async function readGenerationParentRebindStatus({ stateRoot, targetId, watchId } = {}) {
  validateTargetId(targetId); validateWatchId(watchId);
  return withRebindLock(stateRoot, targetId, async (paths) => {
    const journal = await readJournal(paths.journalPath);
    if (journal === null) return null;
    requireJournalIdentity(journal, targetId, watchId);
    return publicStatus(journal);
  });
}

export async function readGenerationParentRebindRecoveryContext({
  stateRoot,
  targetId,
  watchId,
  authorization,
  launchRequest = null,
} = {}) {
  validateTargetId(targetId); validateWatchId(watchId); validateAuthorization(authorization);
  if (launchRequest !== null) validateParentLaunchRequest(launchRequest);
  return withRebindLock(stateRoot, targetId, async (paths) => {
    const journal = await requireJournal(paths.journalPath);
    requireJournalIdentity(journal, targetId, watchId);
    if (journal.authorization_digest !== digestValue(authorization)) {
      fail("E_PARENT_REBIND_AUTHORIZATION_CONFLICT", "rebind recovery authorizationが記録済みdigestと一致しません");
    }
    requireAuthorizationIdentity(authorization, journal);
    if (launchRequest !== null) requireRecoveryLaunchIdentity(launchRequest, journal);
    if (["spawn_authorized", "spawn_observed", "ready_observed"].includes(journal.status)) {
      if (launchRequest === null) fail("E_PARENT_REBIND_LAUNCH_REQUIRED", "rebind recoveryには記録済みlaunch requestが必要です");
      requireDigestMatch(journal.launch_request_digest, digestValue(launchRequest), "rebind launch request");
    }
    return publicStatus(journal);
  });
}

export async function prepareGenerationParentRebindStop({ stateRoot, targetId, watchId } = {}, dependencies = {}) {
  validateTargetId(targetId); validateWatchId(watchId);
  return withRebindLock(stateRoot, targetId, async (paths) => {
    let journal = await requireJournal(paths.journalPath);
    requireJournalIdentity(journal, targetId, watchId);
    if (journal.status === "rebind_required") {
      const authorized = await (dependencies.authorizeGenerationRebind ?? authorizeGenerationRebind)({
        stateRoot, targetId, watchId, expectedGenerationId: journal.from_generation_id,
      }, generationDependencies(dependencies));
      if (authorized.status !== "rebind_required" || authorized.generation_id !== journal.from_generation_id) {
        fail("E_PARENT_REBIND_GENERATION_MISMATCH", "generation rebind authorizationを回収できません");
      }
    }
    const binding = await readBinding({ stateRoot, targetId, watchId }, dependencies);
    requireBinding(binding, journal.from_provider, journal.previous_handle_digest, targetId, watchId);
    let action = "observe_only";
    if (journal.status === "rebind_required") {
      journal = transition(journal, { status: "stop_authorized" }, dependencies.now);
      await atomicReplacePrivateFile(paths.journalPath, serialize(journal));
      action = "issue_once";
    } else if (journal.status !== "stop_authorized") {
      fail("E_PARENT_REBIND_TRANSITION_INVALID", "rebind stopを認可できないjournal statusです");
    }
    const stopping = await (dependencies.requestGenerationRebindStop ?? requestGenerationRebindStop)({
      stateRoot, targetId, watchId, expectedGenerationId: journal.from_generation_id,
    }, generationDependencies(dependencies));
    if (stopping.status !== "stopping" || stopping.generation_id !== journal.from_generation_id) {
      fail("E_PARENT_REBIND_GENERATION_MISMATCH", "old generation stop transitionを確認できません");
    }
    const request = validateParentStopRequest({
      schema: "observer.parent_stop_request.v1",
      provider: journal.from_provider,
      watch_id: watchId,
      target_id: targetId,
      project_root: binding.project_root,
      handle: structuredClone(binding.launch_handle),
      terminal: "stopped",
      fault_code: null,
    });
    return result(journal, action, { stop_request: structuredClone(request) });
  });
}

export async function confirmGenerationParentRebindTerminal({
  stateRoot,
  targetId,
  watchId,
  terminalReceipt,
  stopCommandReceipt = null,
} = {}, dependencies = {}) {
  validateTargetId(targetId); validateWatchId(watchId); validateParentHostReceipt(terminalReceipt, "stopped");
  return withRebindLock(stateRoot, targetId, async (paths) => {
    let journal = await requireJournal(paths.journalPath);
    requireJournalIdentity(journal, targetId, watchId);
    requireReceiptIdentity(terminalReceipt, journal.from_provider, targetId, watchId);
    requireDigestMatch(journal.previous_handle_digest, digestValue(terminalReceipt.handle), "old host handle");
    const receiptDigest = digestValue(terminalReceipt);
    const commandDigest = stopCommandReceipt === null ? null : digestBoundedReceipt(stopCommandReceipt);
    if (journal.status === "terminal_observed") {
      requireDigestMatch(journal.terminal_receipt_digest, receiptDigest, "terminal receipt");
      requireDigestMatch(journal.stop_command_receipt_digest, commandDigest, "stop command receipt");
    } else if (journal.status !== "stop_authorized") {
      fail("E_PARENT_REBIND_TRANSITION_INVALID", "terminal receiptを適用できないjournal statusです");
    }
    const generation = await (dependencies.confirmGenerationTerminal ?? confirmGenerationTerminal)({
      stateRoot, targetId, watchId, terminalReceipt,
    }, generationDependencies(dependencies));
    if (generation.status !== "terminal_confirmed" || generation.generation_id !== journal.from_generation_id) {
      fail("E_PARENT_REBIND_GENERATION_MISMATCH", "old generation terminalを確認できません");
    }
    if (journal.status === "stop_authorized") {
      journal = transition(journal, {
        status: "terminal_observed",
        stop_command_receipt_digest: commandDigest,
        terminal_receipt_digest: receiptDigest,
      }, dependencies.now);
      await atomicReplacePrivateFile(paths.journalPath, serialize(journal));
    }
    return result(journal, "terminal_observed");
  });
}

export async function authorizeReboundGenerationStart({ stateRoot, target, watchId, authorization, launchRequest } = {}, dependencies = {}) {
  validateTarget(target); validateWatchId(watchId); validateAuthorization(authorization); validateParentLaunchRequest(launchRequest);
  return withRebindLock(stateRoot, target.targetId, async (paths) => {
    let journal = await requireJournal(paths.journalPath);
    requireJournalIdentity(journal, target.targetId, watchId);
    if (journal.authorization_digest !== digestValue(authorization)) {
      fail("E_PARENT_REBIND_AUTHORIZATION_CONFLICT", "rebind authorizationが記録済みdigestと一致しません");
    }
    requireAuthorizationIdentity(authorization, journal);
    requireLaunchIdentity(launchRequest, journal, target);
    const launchDigest = digestValue(launchRequest);
    let action = "recover_only";
    if (journal.status === "terminal_observed") {
      journal = transition(journal, {
        status: "spawn_authorized",
        launch_request_digest: launchDigest,
        to_generation_id: generationId(watchId, journal.to_parent_epoch_id, 1),
      }, dependencies.now);
      await atomicReplacePrivateFile(paths.journalPath, serialize(journal));
      action = "issue_once";
    } else if (journal.status !== "spawn_authorized") {
      fail("E_PARENT_REBIND_TRANSITION_INVALID", "new epoch startを認可できないjournal statusです");
    } else requireDigestMatch(journal.launch_request_digest, launchDigest, "rebind launch request");
    const generation = await (dependencies.beginReboundGeneration ?? beginReboundGeneration)({
      stateRoot,
      targetId: target.targetId,
      watchId,
      nextProvider: journal.to_provider,
      parentThreadSha256: authorization.to_parent_thread_sha256,
      expectedFromProvider: journal.from_provider,
      expectedFromGenerationId: journal.from_generation_id,
      expectedFromParentEpochId: journal.from_parent_epoch_id,
    }, generationDependencies(dependencies));
    if (generation.status !== "starting" || generation.generation_id !== journal.to_generation_id ||
        generation.parent_epoch_id !== journal.to_parent_epoch_id || generation.provider !== journal.to_provider || generation.sequence !== 1) {
      fail("E_PARENT_REBIND_GENERATION_MISMATCH", "new epoch generation authorizationを確認できません");
    }
    return result(journal, action, { generation_id: journal.to_generation_id });
  });
}

export async function recordReboundGenerationSpawn({ stateRoot, targetId, watchId, spawnReceipt } = {}, dependencies = {}) {
  validateTargetId(targetId); validateWatchId(watchId); validateParentHostReceipt(spawnReceipt, "spawned");
  return withRebindLock(stateRoot, targetId, async (paths) => {
    let journal = await requireJournal(paths.journalPath);
    requireJournalIdentity(journal, targetId, watchId);
    requireReceiptIdentity(spawnReceipt, journal.to_provider, targetId, watchId);
    const receiptDigest = digestValue(spawnReceipt);
    const handleDigest = digestValue(spawnReceipt.handle);
    if (journal.status === "spawn_observed") {
      requireDigestMatch(journal.spawn_receipt_digest, receiptDigest, "spawn receipt");
      requireDigestMatch(journal.next_handle_digest, handleDigest, "new host handle");
    } else if (journal.status === "spawn_authorized") {
      journal = transition(journal, {
        status: "spawn_observed",
        spawn_receipt_digest: receiptDigest,
        next_handle_digest: handleDigest,
      }, dependencies.now);
      await atomicReplacePrivateFile(paths.journalPath, serialize(journal));
    } else fail("E_PARENT_REBIND_TRANSITION_INVALID", "spawn receiptを適用できないjournal statusです");
    const binding = await readBinding({ stateRoot, targetId, watchId }, dependencies);
    const bindingHandleDigest = digestValue(binding.launch_handle);
    if (binding.provider === journal.from_provider && bindingHandleDigest === journal.previous_handle_digest) {
      await (dependencies.compareAndSwapWatchHostBinding ?? compareAndSwapWatchHostBinding)({
        stateRoot,
        targetId,
        watchId,
        expectedProvider: journal.from_provider,
        expectedLaunchHandle: binding.launch_handle,
        nextProvider: journal.to_provider,
        nextLaunchHandle: structuredClone(spawnReceipt.handle),
      }, watchDependencies(dependencies));
    } else requireBinding(binding, journal.to_provider, journal.next_handle_digest, targetId, watchId);
    return result(journal, "spawn_observed");
  });
}

export async function activateReboundGeneration({ stateRoot, targetId, watchId, readyReceipt } = {}, dependencies = {}) {
  validateTargetId(targetId); validateWatchId(watchId); validateParentHostReceipt(readyReceipt, "ready");
  return withRebindLock(stateRoot, targetId, async (paths) => {
    let journal = await requireJournal(paths.journalPath);
    requireJournalIdentity(journal, targetId, watchId);
    requireReceiptIdentity(readyReceipt, journal.to_provider, targetId, watchId);
    requireDigestMatch(journal.next_handle_digest, digestValue(readyReceipt.handle), "ready host handle");
    const binding = await readBinding({ stateRoot, targetId, watchId }, dependencies);
    requireBinding(binding, journal.to_provider, journal.next_handle_digest, targetId, watchId);
    const readyDigest = digestValue(readyReceipt);
    if (journal.status === "ready_observed") {
      requireDigestMatch(journal.ready_receipt_digest, readyDigest, "ready receipt");
    } else if (journal.status === "spawn_observed") {
      journal = transition(journal, { status: "ready_observed", ready_receipt_digest: readyDigest }, dependencies.now);
      await atomicReplacePrivateFile(paths.journalPath, serialize(journal));
    } else fail("E_PARENT_REBIND_TRANSITION_INVALID", "ready receiptを適用できないjournal statusです");
    const generation = await (dependencies.activateGeneration ?? activateGeneration)({
      stateRoot, targetId, watchId, readyReceipt,
    }, generationDependencies(dependencies));
    if (generation.status !== "active" || generation.generation_id !== journal.to_generation_id ||
        generation.parent_epoch_id !== journal.to_parent_epoch_id || generation.provider !== journal.to_provider) {
      fail("E_PARENT_REBIND_GENERATION_MISMATCH", "new epoch generation activationを確認できません");
    }
    await removePrivateFile(paths.journalPath);
    return result(journal, "activated", { generation_id: generation.generation_id });
  });
}

function buildAuthorization({ generation, target, watchId, cycleId, proposedParent }) {
  const value = {
    schema: PARENT_REBIND_AUTHORIZATION_SCHEMA,
    target_id: target.targetId,
    watch_id: watchId,
    cycle_id: cycleId,
    from_provider: generation.provider,
    to_provider: proposedParent.host,
    from_parent_epoch_id: generation.parent_epoch_id,
    to_parent_epoch_id: generationParentEpochId(proposedParent.host, proposedParent.thread_sha256),
    to_parent_thread_sha256: proposedParent.thread_sha256,
    from_generation_id: generation.generation_id,
    through_cursor_sha256: digestParts("observer.cursor.v1", proposedParent.cursor),
  };
  return validateAuthorization(value);
}

function buildAuthorizationFromJournal({ journal, target, cycleId, proposedParent }) {
  return buildAuthorization({
    generation: {
      provider: journal.from_provider,
      parent_epoch_id: journal.from_parent_epoch_id,
      generation_id: journal.from_generation_id,
    },
    target,
    watchId: journal.watch_id,
    cycleId,
    proposedParent,
  });
}

function validateAuthorization(value) {
  plain(value, "parent rebind authorization", "E_PARENT_REBIND_AUTHORIZATION_INVALID");
  exact(value, AUTHORIZATION_KEYS, "parent rebind authorization", "E_PARENT_REBIND_AUTHORIZATION_INVALID");
  if (value.schema !== PARENT_REBIND_AUTHORIZATION_SCHEMA || !TARGET.test(value.target_id) || !WATCH.test(value.watch_id) ||
      !CYCLE.test(value.cycle_id) || !providers(value.from_provider, value.to_provider) ||
      !DIGEST.test(value.from_parent_epoch_id) || !DIGEST.test(value.to_parent_epoch_id) ||
      !HEX.test(value.to_parent_thread_sha256) || !DIGEST.test(value.from_generation_id) ||
      !DIGEST.test(value.through_cursor_sha256) ||
      generationParentEpochId(value.to_provider, value.to_parent_thread_sha256) !== value.to_parent_epoch_id) {
    fail("E_PARENT_REBIND_AUTHORIZATION_INVALID", "parent rebind authorizationが不正です");
  }
  return value;
}

function validateProposedParent(value, target) {
  plain(value, "proposed parent", "E_PARENT_REBIND_PROPOSAL_INVALID");
  exact(value, ["cursor", "host", "project_root", "schema", "status", "target_id", "thread_sha256"], "proposed parent", "E_PARENT_REBIND_PROPOSAL_INVALID");
  if (value.schema !== "observer.parent_state.v1" || value.status !== "ready" || value.target_id !== target.targetId ||
      value.project_root !== target.projectRoot || !["claude", "codex"].includes(value.host) ||
      !HEX.test(value.thread_sha256) || typeof value.cursor !== "string" || value.cursor.length === 0 || value.cursor.length > 4096) {
    fail("E_PARENT_REBIND_PROPOSAL_INVALID", "proposed parentがrebind authorizationに使えません");
  }
}

function requireCurrentIdentity(generation, binding, { target, watchId }) {
  if (!plainObject(generation) || generation.schema !== "observer.generation_state.v1" || !["active", "rebind_required"].includes(generation.status) ||
      generation.target_id !== target.targetId || generation.watch_id !== watchId || generation.provider !== binding.provider ||
      generation.pending_reservation !== null ||
      !plainObject(binding) || binding.schema !== "observer.watch_host_binding.v1" || binding.status !== "active" ||
      binding.target_id !== target.targetId || binding.watch_id !== watchId || binding.project_root !== target.projectRoot) {
    fail("E_PARENT_REBIND_CURRENT_IDENTITY_INVALID", "active watch／generationがrebind元として一致しません");
  }
}

function requireAuthorizationIdentity(authorization, journal) {
  if (authorization.target_id !== journal.target_id || authorization.watch_id !== journal.watch_id ||
      authorization.from_provider !== journal.from_provider || authorization.to_provider !== journal.to_provider ||
      authorization.from_parent_epoch_id !== journal.from_parent_epoch_id || authorization.to_parent_epoch_id !== journal.to_parent_epoch_id ||
      authorization.from_generation_id !== journal.from_generation_id) {
    fail("E_PARENT_REBIND_AUTHORIZATION_CONFLICT", "parent rebind authorization identityがjournalと一致しません");
  }
}

function requireLaunchIdentity(request, journal, target) {
  if (request.provider !== journal.to_provider || request.target_id !== journal.target_id || request.watch_id !== journal.watch_id ||
      request.project_root !== target.projectRoot || request.target_id !== target.targetId || request.child_start.provider !== journal.to_provider) {
    fail("E_PARENT_REBIND_LAUNCH_CONFLICT", "new epoch launch requestがrebind authorizationと一致しません");
  }
}

function requireRecoveryLaunchIdentity(request, journal) {
  if (request.provider !== journal.to_provider || request.target_id !== journal.target_id || request.watch_id !== journal.watch_id ||
      request.child_start.provider !== journal.to_provider || request.child_start.target_id !== journal.target_id ||
      request.child_start.watch_id !== journal.watch_id) {
    fail("E_PARENT_REBIND_LAUNCH_CONFLICT", "rebind recovery launch requestがjournal identityと一致しません");
  }
}

function requireReceiptIdentity(receipt, provider, targetId, watchId) {
  if (receipt.provider !== provider || receipt.target_id !== targetId || receipt.watch_id !== watchId) {
    fail("E_PARENT_REBIND_RECEIPT_MISMATCH", "provider receiptがrebind identityと一致しません");
  }
}

function requireBinding(binding, provider, handleDigest, targetId, watchId) {
  if (!plainObject(binding) || binding.schema !== "observer.watch_host_binding.v1" || binding.status !== "active" ||
      binding.target_id !== targetId || binding.watch_id !== watchId || !isAbsolute(binding.project_root) ||
      binding.provider !== provider || digestValue(binding.launch_handle) !== handleDigest) {
    fail("E_PARENT_REBIND_WATCH_BINDING_MISMATCH", "watch host bindingがrebind journalと一致しません");
  }
}

function publicStatus(journal) {
  return {
    schema: GENERATION_PARENT_REBIND_STATUS_SCHEMA,
    target_id: journal.target_id,
    watch_id: journal.watch_id,
    from_provider: journal.from_provider,
    to_provider: journal.to_provider,
    from_parent_epoch_id: journal.from_parent_epoch_id,
    to_parent_epoch_id: journal.to_parent_epoch_id,
    from_generation_id: journal.from_generation_id,
    to_generation_id: journal.to_generation_id,
    status: journal.status,
    action: ACTIONS[journal.status],
  };
}

function result(journal, action, extra = {}) {
  return { ...publicStatus(journal), schema: GENERATION_PARENT_REBIND_RESULT_SCHEMA, outcome: action, ...extra };
}

async function readBinding(args, dependencies) {
  return (dependencies.readWatchHostBinding ?? readWatchHostBinding)(args);
}

function generationDependencies(dependencies) {
  return { ...(dependencies.generationDependencies ?? {}), now: dependencies.generationDependencies?.now ?? dependencies.now };
}

function watchDependencies(dependencies) {
  return { ...(dependencies.watchDependencies ?? {}), now: dependencies.watchDependencies?.now ?? dependencies.now };
}

async function withRebindLock(stateRoot, targetId, operation) {
  const paths = await rebindPaths(stateRoot, targetId);
  let release;
  try { release = await acquirePrivateLock(paths.lockPath); }
  catch (error) {
    if (error instanceof ObserverError && error.code === "E_CONSUMER_LOCKED") fail("E_PARENT_REBIND_LOCKED", "別のparent rebind transactionが進行中です");
    throw error;
  }
  let primary = null;
  try { return await operation(paths); }
  catch (error) { primary = error; throw error; }
  finally {
    try { await release(); }
    catch (error) { if (primary !== null) throw new AggregateError([primary, error], "parent rebindとlock解放が失敗しました"); throw error; }
  }
}

async function rebindPaths(stateRoot, targetId) {
  if (!isAbsolute(stateRoot) || !TARGET.test(targetId)) fail("E_PARENT_REBIND_INPUT_INVALID", "parent rebind state identityが不正です");
  const root = resolve(stateRoot);
  const watches = assertWithin(root, join(root, "watches"));
  const directory = assertWithin(root, join(watches, targetId));
  await assertPrivateDirectory(root); await assertPrivateDirectory(watches); await assertPrivateDirectory(directory);
  return { journalPath: join(directory, "parent-rebind.json"), lockPath: join(directory, "parent-rebind.lock") };
}

async function readJournal(path) {
  try { return validateJournal(await readPrivateJson(path)); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function requireJournal(path) {
  const journal = await readJournal(path);
  if (journal === null) fail("E_PARENT_REBIND_NOT_FOUND", "parent rebind journalがありません");
  return journal;
}

function validateJournal(value) {
  plain(value, "parent rebind journal", "E_PARENT_REBIND_STATE_INVALID");
  const keys = Object.keys(value).sort();
  const legacyKeys = [...LEGACY_JOURNAL_KEYS].sort();
  if (keys.length === legacyKeys.length && keys.every((key, index) => key === legacyKeys[index])) {
    value = { ...value, stop_command_receipt_digest: null };
  }
  exact(value, JOURNAL_KEYS, "parent rebind journal", "E_PARENT_REBIND_STATE_INVALID");
  if (value.schema !== GENERATION_PARENT_REBIND_SCHEMA || !TARGET.test(value.target_id) || !WATCH.test(value.watch_id) ||
      !providers(value.from_provider, value.to_provider) || !DIGEST.test(value.from_parent_epoch_id) ||
      !DIGEST.test(value.to_parent_epoch_id) || value.from_parent_epoch_id === value.to_parent_epoch_id ||
      !DIGEST.test(value.from_generation_id) || !STATUSES.has(value.status) || !DIGEST.test(value.authorization_digest) ||
      !DIGEST.test(value.previous_handle_digest)) invalidState();
  for (const field of ["to_generation_id", "launch_request_digest", "spawn_receipt_digest", "next_handle_digest", "ready_receipt_digest", "stop_command_receipt_digest", "terminal_receipt_digest"]) {
    if (value[field] !== null && !DIGEST.test(value[field])) invalidState();
  }
  if (value.to_generation_id !== null && value.to_generation_id !== generationId(value.watch_id, value.to_parent_epoch_id, 1)) invalidState();
  canonicalTime(value.created_at); canonicalTime(value.updated_at);
  if (Date.parse(value.updated_at) < Date.parse(value.created_at)) invalidState();
  if (["rebind_required", "stop_authorized"].includes(value.status)) {
    if (value.stop_command_receipt_digest !== null || value.terminal_receipt_digest !== null || value.to_generation_id !== null || value.launch_request_digest !== null || value.spawn_receipt_digest !== null || value.next_handle_digest !== null || value.ready_receipt_digest !== null) invalidState();
  } else if (value.status === "terminal_observed") {
    if (value.terminal_receipt_digest === null || value.to_generation_id !== null || value.launch_request_digest !== null || value.spawn_receipt_digest !== null || value.next_handle_digest !== null || value.ready_receipt_digest !== null) invalidState();
  } else if (value.status === "spawn_authorized") {
    if (value.terminal_receipt_digest === null || value.to_generation_id === null || value.launch_request_digest === null || value.spawn_receipt_digest !== null || value.next_handle_digest !== null || value.ready_receipt_digest !== null) invalidState();
  } else if (value.status === "spawn_observed") {
    if (value.terminal_receipt_digest === null || value.to_generation_id === null || value.launch_request_digest === null || value.spawn_receipt_digest === null || value.next_handle_digest === null || value.ready_receipt_digest !== null) invalidState();
  } else if (value.terminal_receipt_digest === null || value.to_generation_id === null || value.launch_request_digest === null || value.spawn_receipt_digest === null || value.next_handle_digest === null || value.ready_receipt_digest === null) invalidState();
  return value;
}

function transition(journal, patch, now) {
  return validateJournal({ ...journal, ...patch, updated_at: nextTimestamp(journal, now) });
}

function requireJournalIdentity(journal, targetId, watchId) {
  if (journal.target_id !== targetId || journal.watch_id !== watchId) fail("E_PARENT_REBIND_IDENTITY_CHANGED", "parent rebind journal identityが変化しました");
}

function requireDigestMatch(expected, actual, field) {
  if (expected !== actual) fail("E_PARENT_REBIND_RECEIPT_CONFLICT", `${field}が記録済みdigestと一致しません`);
}

function validateTarget(value) {
  plain(value, "project target", "E_PARENT_REBIND_INPUT_INVALID"); exact(value, ["projectRoot", "schema", "targetId"], "project target", "E_PARENT_REBIND_INPUT_INVALID");
  if (value.schema !== "observer.project_target.v1" || !TARGET.test(value.targetId) || !isAbsolute(value.projectRoot)) fail("E_PARENT_REBIND_INPUT_INVALID", "project targetが不正です");
}

function validateTargetId(value) { if (typeof value !== "string" || !TARGET.test(value)) fail("E_PARENT_REBIND_INPUT_INVALID", "target IDが不正です"); }
function validateWatchId(value) { if (typeof value !== "string" || !WATCH.test(value)) fail("E_PARENT_REBIND_INPUT_INVALID", "watch IDが不正です"); }
function validateCycleId(value) { if (typeof value !== "string" || !CYCLE.test(value)) fail("E_PARENT_REBIND_INPUT_INVALID", "cycle IDが不正です"); }
function providers(left, right) { return [left, right].every((value) => ["claude", "codex"].includes(value)); }
function generationId(watchId, parentEpochId, sequence) { return digestParts("observer.generation.v1", watchId, parentEpochId, String(sequence)); }
function digestBoundedReceipt(value) {
  plain(value, "stop command receipt", "E_PARENT_REBIND_RECEIPT_INVALID");
  const encoded = canonical(value);
  if (Buffer.byteLength(encoded, "utf8") > 16 * 1024) fail("E_PARENT_REBIND_RECEIPT_INVALID", "stop command receiptが大きすぎます");
  return `sha256:${createHash("sha256").update(encoded, "utf8").digest("hex")}`;
}
function digestValue(value) { return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`; }
function digestParts(domain, ...parts) { const hash = createHash("sha256").update(`${domain}\0`, "utf8"); for (const part of parts) hash.update(`${part}\0`, "utf8"); return `sha256:${hash.digest("hex")}`; }
function canonical(value) { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; }
function timestamp(clock) { const value = (clock ?? (() => new Date()))(); if (!(value instanceof Date) || Number.isNaN(value.getTime())) fail("E_PARENT_REBIND_CLOCK_INVALID", "parent rebind clockが不正です"); return value.toISOString(); }
function nextTimestamp(journal, clock) { const value = timestamp(clock); if (Date.parse(value) < Date.parse(journal.updated_at)) fail("E_PARENT_REBIND_CLOCK_ROLLBACK", "parent rebind clockが後退しました"); return value; }
function canonicalTime(value) { const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN; if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) invalidState(); }
function serialize(value) { return `${JSON.stringify(value)}\n`; }
function plainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function plain(value, field, code) { if (!plainObject(value)) fail(code, `${field}はplain objectである必要があります`); }
function exact(value, keys, field, code) { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code, `${field}に未知または不足fieldがあります`); }
function invalidState() { fail("E_PARENT_REBIND_STATE_INVALID", "parent rebind journalが不正です"); }
