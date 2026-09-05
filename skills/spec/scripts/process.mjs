import { spawn, spawnSync } from "node:child_process";
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

/** Capture a supervised command asynchronously so cancellation can stop its whole group. */
export async function spawnBounded(command, args, { cwd, env, input, signal, timeout = 120000, maxBuffer = 32 * 1024 * 1024 } = {}) {
  if (process.platform === "win32") throw new Error("Subprocess supervision requires POSIX process groups; use WSL on Windows");
  const stopped = () => Object.assign(new Error("Operation stopped"), { code: "ABORT_ERR" });
  if (signal?.aborted) return { status: null, error: stopped(), stdout: "", stderr: "" };
  const dir = mkdtempSync(join(tmpdir(), "rusubon-process-"));
  const request = join(dir, "request.json"), response = join(dir, "response.json");
  try {
    writeFileSync(request, JSON.stringify({ command, args, timeout, parentPid: process.pid }), { mode: 0o600 });
    writeFileSync(response, "", { mode: 0o600 });
    return await new Promise(resolve => {
      const child = spawn(process.execPath, [supervisor, request, response], { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      const stdout = [], stderr = [];
      let failure, bytes = 0;
      const stop = error => { failure ||= error; child.kill("SIGTERM"); };
      const abort = () => stop(stopped());
      const capture = chunks => chunk => {
        bytes += chunk.length;
        if (bytes > maxBuffer) stop(Object.assign(new Error("Command output exceeded its limit"), { code: "ENOBUFS" }));
        else chunks.push(chunk);
      };
      child.stdout.on("data", capture(stdout)); child.stderr.on("data", capture(stderr));
      child.on("error", error => { failure ||= error; });
      child.stdin.on("error", error => { if (error.code !== "EPIPE") stop(error); });
      child.on("close", () => {
        signal?.removeEventListener("abort", abort);
        let outcome;
        try { outcome = JSON.parse(readFileSync(response, "utf8")); }
        catch { failure ||= new Error("subprocess supervisor did not report an outcome"); }
        resolve({ status: failure ? null : outcome.status, signal: outcome?.signal,
          error: failure || (outcome?.error ? Object.assign(new Error(outcome.error.message), { code: outcome.error.code }) : undefined),
          stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.stdin.end(input);
    });
  } finally {
    for (const path of [request, response]) {
      try { unlinkSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    rmdirSync(dir);
  }
}
