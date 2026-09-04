import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

export function trashFixture(path) {
  const result = spawnSync("trash", [path], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    console.warn(`trash is unavailable; retained test fixture ${path}`);
    return;
  }
  assert.equal(result.status, 0, result.stderr || "could not trash test fixture");
}
