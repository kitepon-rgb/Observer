import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const [modeOrPidFile] = process.argv.slice(2);

if (modeOrPidFile === "--survivor") {
  process.on("SIGTERM", () => {});
  process.send?.("ready");
  setInterval(() => {}, 1_000);
} else {
  const survivor = spawn(process.execPath, [fileURLToPath(import.meta.url), "--survivor"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  survivor.once("message", async (message) => {
    if (message !== "ready") process.exit(2);
    await writeFile(modeOrPidFile, `${survivor.pid}\n`, { encoding: "utf8", mode: 0o600 });
    survivor.disconnect();
    survivor.unref();
    process.exit(0);
  });
}
