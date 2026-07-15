import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  PARENT_STOP_HOOK_TIMEOUT_SECONDS,
  buildParentStopHookFragment,
  verifyParentStopHookConfig,
} from "../src/parent-stop-hook-config.mjs";

const CLI = new URL("../bin/observer-hook-config.mjs", import.meta.url).pathname;
const EXECUTABLE = "/Users/kite/Developer/Observer/bin/observer-parent-stop-hook.mjs";

function fragment(provider) {
  return buildParentStopHookFragment({ provider, executablePath: EXECUTABLE });
}

function candidate(provider, entries) {
  return { hooks: { Stop: entries ?? [fragment(provider).entry] } };
}

test("provider別のcanonical fragmentはversioned schemaと固定timeoutを返す", () => {
  assert.equal(PARENT_STOP_HOOK_TIMEOUT_SECONDS, 5);
  assert.deepEqual(fragment("claude"), {
    schema: "observer.parent_stop_hook_fragment.v1",
    provider: "claude",
    event: "Stop",
    entry: { hooks: [{ type: "command", command: `${EXECUTABLE} --provider claude`, timeout: 5 }] },
  });
  assert.deepEqual(fragment("codex"), {
    schema: "observer.parent_stop_hook_fragment.v1",
    provider: "codex",
    event: "Stop",
    entry: { type: "command", command: `${EXECUTABLE} --provider codex`, timeoutSec: 5, async: false, statusMessage: null },
  });
});

test("macOS v1でquote、空白、相対pathをfail closedする", () => {
  for (const executablePath of ["relative/hook", "/tmp/hook with space", '/tmp/hook"quoted']) {
    assert.throws(() => buildParentStopHookFragment({ provider: "claude", executablePath }), (error) => error?.code === "E_PARENT_STOP_HOOK_EXECUTABLE_INVALID");
  }
});

test("実在しない、または実行できないexecutableをfail closedする", async () => {
  const root = await mkdtemp(join(tmpdir(), "observer-hook-config-"));
  const nonexecutable = join(root, "hook");
  await writeFile(nonexecutable, "#!/usr/bin/env node\n");
  await chmod(nonexecutable, 0o644);
  for (const executablePath of [join(root, "missing"), nonexecutable]) {
    assert.throws(() => buildParentStopHookFragment({ provider: "claude", executablePath }), (error) => error?.code === "E_PARENT_STOP_HOOK_EXECUTABLE_UNAVAILABLE");
    assert.throws(() => verifyParentStopHookConfig({ provider: "claude", executablePath, candidate: {} }), (error) => error?.code === "E_PARENT_STOP_HOOK_EXECUTABLE_UNAVAILABLE");
  }
});

for (const provider of ["claude", "codex"]) {
  test(`${provider} verifierは対象commandだけを数えcanonical性を判定する`, () => {
    assert.equal(verifyParentStopHookConfig({ provider, executablePath: EXECUTABLE, candidate: candidate(provider) }).status, "canonical");
    assert.equal(verifyParentStopHookConfig({ provider, executablePath: EXECUTABLE, candidate: candidate(provider, []) }).status, "missing");
    assert.equal(verifyParentStopHookConfig({ provider, executablePath: EXECUTABLE, candidate: {} }).status, "missing");
    assert.equal(verifyParentStopHookConfig({ provider, executablePath: EXECUTABLE, candidate: { hooks: {} } }).status, "missing");

    const noncanonical = structuredClone(fragment(provider).entry);
    if (provider === "claude") noncanonical.hooks[0].timeout = 6;
    else noncanonical.async = true;
    assert.equal(verifyParentStopHookConfig({ provider, executablePath: EXECUTABLE, candidate: candidate(provider, [noncanonical]) }).status, "noncanonical");

    const duplicated = [fragment(provider).entry, fragment(provider).entry];
    const result = verifyParentStopHookConfig({ provider, executablePath: EXECUTABLE, candidate: candidate(provider, duplicated) });
    assert.equal(result.status, "duplicate");
    assert.equal(result.target_count, 2);

    const otherProduct = provider === "claude"
      ? { hooks: [{ type: "command", command: "/usr/local/bin/other-product --provider claude", timeout: 5 }] }
      : { type: "command", command: "/usr/local/bin/other-product --provider codex", timeoutSec: 5, async: false, statusMessage: null };
    const withOtherProduct = verifyParentStopHookConfig({
      provider,
      executablePath: EXECUTABLE,
      candidate: candidate(provider, [fragment(provider).entry, otherProduct]),
    });
    assert.equal(withOtherProduct.status, "canonical");
    assert.equal(withOtherProduct.target_count, 1);
  });
}

test("CLIはflagとbounded stdinでfragmentとverification JSONを返す", () => {
  const generated = spawnSync(process.execPath, [CLI, "fragment", "--provider", "codex", "--executable", EXECUTABLE], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  assert.deepEqual(JSON.parse(generated.stdout), fragment("codex"));

  const verified = spawnSync(process.execPath, [CLI, "verify", "--provider", "codex", "--executable", EXECUTABLE], {
    encoding: "utf8",
    input: JSON.stringify(candidate("codex")),
  });
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).status, "canonical");
});

test("CLIはusageをexit 2、既知エラーをstderr JSONで返す", () => {
  const usage = spawnSync(process.execPath, [CLI, "fragment"], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /^usage:/u);

  const invalid = spawnSync(process.execPath, [CLI, "fragment", "--provider", "codex", "--executable", "relative"], { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stderr).error.code, "E_PARENT_STOP_HOOK_EXECUTABLE_INVALID");
});
