import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const supervisor = fileURLToPath(new URL("./process-supervisor.mjs", import.meta.url));

/** Run a synchronous command with supervised descendant cleanup when a deadline is set.
 * Preserve captured or inherited stdio and native spawn errors. */
export function spawnBoundedSync(command, args, options = {}) {
  if (!(options.timeout > 0)) return spawnSync(command, args, options);
  if (process.platform === "win32") {
    throw new Error("Timed subprocess supervision requires POSIX process groups; use WSL on Windows");
  }
  const dir = mkdtempSync(join(tmpdir(), "rusubon-process-"));
  const request = join(dir, "request.json");
  const response = join(dir, "response.json");
  try {
    writeFileSync(request, JSON.stringify({ command, args, timeout: options.timeout, parentPid: process.pid }), { mode: 0o600 });
    writeFileSync(response, "", { mode: 0o600 });
    const result = spawnSync(process.execPath, [supervisor, request, response], {
      ...options, timeout: undefined, detached: true,
      // The supervisor watches caller loss and handles native output-buffer overflow.
      killSignal: "SIGTERM",
    });
    if (result.error) return result;
    let outcome;
    try { outcome = JSON.parse(readFileSync(response, "utf8")); }
    catch { return { ...result, status: null, error: new Error("subprocess supervisor did not report an outcome") }; }
    return { ...result, status: outcome.status, signal: outcome.signal,
      error: outcome.error ? Object.assign(new Error(outcome.error.message), { code: outcome.error.code }) : undefined };
  } finally {
    // Remove only this invocation's known private files and its now-empty directory.
    for (const path of [request, response]) {
      try { unlinkSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    rmdirSync(dir);
  }
}
