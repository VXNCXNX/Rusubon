import { spawnBoundedSync as spawnSync } from "../../skills/spec/scripts/process.mjs";

/** Trash a temporary fixture within the supplied millisecond budget, warning on failure. */
export function trashFixture(path, timeoutMs = 30000) {
  // The supervisor also terminates descendants if cleanup exceeds its budget.
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
