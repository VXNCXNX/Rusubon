import { spawnSync } from "node:child_process";

/** Trash a temporary fixture, retaining it with a warning if cleanup fails. */
export function trashFixture(path) {
  const result = spawnSync("trash", [path], { encoding: "utf8", timeout: 30000 });
  if (result.status === 0) return;
  if (result.error?.code === "ENOENT") {
    console.warn(`trash is unavailable; retained test fixture ${path}`);
    return;
  }
  console.warn(`trash failed (${result.error?.code || result.signal || result.status}); retained test fixture ${path}`);
}
