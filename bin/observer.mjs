#!/usr/bin/env node

import { executeObserverCommand, formatObserverCliError } from "../src/observer-cli.mjs";

const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
  const outcome = await executeObserverCommand(process.argv.slice(2), { signal: controller.signal });
  process.stdout.write(`${JSON.stringify(outcome.result)}\n`);
  process.exitCode = outcome.exitCode;
} catch (error) {
  const outcome = formatObserverCliError(error);
  process.stderr.write(`${JSON.stringify(outcome.result)}\n`);
  process.exitCode = outcome.exitCode;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
