import { spawn } from "node:child_process";
import { readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

if (process.platform === "win32") throw new Error("Subprocess supervision requires POSIX process groups; use WSL on Windows");
const [requestPath, responsePath] = process.argv.slice(2);
const { command, args, timeout, parentPid } = JSON.parse(readFileSync(requestPath, "utf8"));
let finished = false;

/** Save the command outcome before terminating the supervised process group. */
function finish(status, signal, error) {
  if (finished) return;
  finished = true;
  try {
    if (process.ppid === parentPid) {
      writeFileSync(responsePath, JSON.stringify({ status, signal, error }));
    } else {
      // A terminated caller cannot run its finally block. Remove only our files.
      for (const path of [requestPath, responsePath]) {
        try { unlinkSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      rmdirSync(dirname(requestPath));
    }
  } finally {
    // This supervisor leads a fresh group. Always stop descendants, even if
    // saving the outcome or cleaning up an orphaned request fails.
    process.kill(-process.pid, "SIGKILL");
  }
}

process.on("SIGTERM", () => finish(null, "SIGTERM"));
process.on("SIGINT", () => finish(null, "SIGINT"));
// spawnSync blocks the caller's JS signal handlers. Observe kernel reparenting
// here instead of relying on the caller to forward terminal signals. The PID
// comes from the request so caller loss before supervisor startup is covered.
const checkParent = () => {
  if (process.ppid !== parentPid) finish(null, "SIGTERM");
};
checkParent();
setInterval(checkParent, 100);
const timer = setTimeout(() => finish(null, "SIGKILL", {
  code: "ETIMEDOUT", message: "subprocess exceeded its deadline",
}), timeout);
const child = spawn(command, args, { stdio: "inherit" });
child.on("error", (error) => finish(null, null, { code: error.code, message: error.message }));
child.on("exit", (status, signal) => {
  clearTimeout(timer);
  finish(status, signal);
});
