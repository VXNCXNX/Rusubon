import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

if (process.platform === "win32") throw new Error("Subprocess supervision requires POSIX process groups; use WSL on Windows");
const [requestPath, responsePath] = process.argv.slice(2);
const { command, args, timeout } = JSON.parse(readFileSync(requestPath, "utf8"));
let finished = false;

/** Save the command outcome before terminating the supervised process group. */
function finish(status, signal, error) {
  if (finished) return;
  finished = true;
  writeFileSync(responsePath, JSON.stringify({ status, signal, error }));
  // This supervisor is the leader of a fresh group, separate from the caller.
  // Kill the whole group even after normal exit, before inherited pipes can linger.
  process.kill(-process.pid, "SIGKILL");
}

process.on("SIGTERM", () => finish(null, "SIGTERM"));
process.on("SIGINT", () => finish(null, "SIGINT"));
const timer = setTimeout(() => finish(null, "SIGKILL", {
  code: "ETIMEDOUT", message: "subprocess exceeded its deadline",
}), timeout);
const child = spawn(command, args, { stdio: "inherit" });
child.on("error", (error) => finish(null, null, { code: error.code, message: error.message }));
child.on("exit", (status, signal) => {
  clearTimeout(timer);
  finish(status, signal);
});
