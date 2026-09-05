import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [requestPath, responsePath] = process.argv.slice(2);
const { command, args, timeout } = JSON.parse(readFileSync(requestPath, "utf8"));
let child;
let finished = false;

/** Save the command outcome before terminating the supervised process group. */
function finish(status, signal, error) {
  if (finished) return;
  finished = true;
  if (process.platform === "win32" && child?.pid && status === null) {
    const killed = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore", timeout: 10000, killSignal: "SIGKILL",
    });
    if (killed.error || killed.status !== 0) error = { code: "ECLEANUP", message: "could not terminate subprocess tree" };
  }
  writeFileSync(responsePath, JSON.stringify({ status, signal, error }));
  if (process.platform !== "win32") {
    // This supervisor is the leader of a fresh group, separate from the caller.
    // Kill the whole group even after normal exit, before inherited pipes can linger.
    process.kill(-process.pid, "SIGKILL");
  }
  process.exit(status ?? 1);
}

process.on("SIGTERM", () => finish(null, "SIGTERM"));
process.on("SIGINT", () => finish(null, "SIGINT"));
const timer = setTimeout(() => finish(null, "SIGKILL", {
  code: "ETIMEDOUT", message: "subprocess exceeded its deadline",
}), timeout);
child = spawn(command, args, { stdio: "inherit", windowsHide: true });
child.on("error", (error) => finish(null, null, { code: error.code, message: error.message }));
child.on("exit", (status, signal) => {
  clearTimeout(timer);
  finish(status, signal);
});
