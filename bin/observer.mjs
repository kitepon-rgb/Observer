#!/usr/bin/env node

import { isAbsolute } from "node:path";

import { ObserverError, fail } from "../src/observer-error.mjs";
import { defaultStateRoot } from "../src/private-state.mjs";
import { registerProjectTarget } from "../src/project-target.mjs";

function usage() {
  return "usage: observer target register <absolute-project-root> [--state-root <absolute-path>]";
}

function parseArguments(argv) {
  if (argv.length < 3 || argv[0] !== "target" || argv[1] !== "register") fail("E_USAGE", usage());
  const projectRoot = argv[2];
  let stateRoot;
  for (let index = 3; index < argv.length; index += 1) {
    if (argv[index] !== "--state-root" || stateRoot !== undefined || index + 1 >= argv.length) fail("E_USAGE", usage());
    stateRoot = argv[index + 1];
    index += 1;
  }
  if (!isAbsolute(projectRoot)) fail("E_PROJECT_PATH_NOT_ABSOLUTE", "project rootは絶対パスで指定してください");
  if (stateRoot !== undefined && !isAbsolute(stateRoot)) fail("E_PATH_NOT_ABSOLUTE", "state rootは絶対パスで指定してください");
  return { projectRoot, stateRoot: stateRoot ?? defaultStateRoot() };
}

try {
  const input = parseArguments(process.argv.slice(2));
  const target = await registerProjectTarget(input);
  process.stdout.write(`${JSON.stringify({
    schema: "observer.cli_result.v1",
    status: target.created ? "created" : "existing",
    target_id: target.targetId,
    project_root: target.projectRoot,
  })}\n`);
} catch (error) {
  const known = error instanceof ObserverError;
  process.stderr.write(`${JSON.stringify({
    schema: "observer.cli_error.v1",
    code: known ? error.code : "E_INTERNAL",
    message: error.message,
  })}\n`);
  process.exitCode = known && error.code === "E_USAGE" ? 2 : 1;
}
