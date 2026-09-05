import { spawnSync } from "node:child_process";

/** Trash a temporary fixture within the supplied millisecond budget, warning on failure. */
export function trashFixture(path, timeoutMs = 30000) {
  // SIGKILL cannot be caught; ignored stdio prevents descendants holding pipes open.
  const result = spawnSync("trash", [path], {
    stdio: "ignore", timeout: timeoutMs, killSignal: "SIGKILL",
  });
  if (result.status === 0) return;
  if (result.error?.code === "ENOENT") {
    console.warn(`trash is unavailable; retained test fixture ${path}`);
    return;
  }
  console.warn(`trash failed (${result.error?.code || result.signal || result.status}); retained test fixture ${path}`);
}
