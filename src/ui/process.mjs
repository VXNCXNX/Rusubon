import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { redact } from "../doctor.mjs";

export function safeText(value) {
  return redact(String(value ?? ""))
    .replace(/\b(sk-(?:ant-)?[\w-]{8,}|gh[pousr]_[\w]{8,}|github_pat_[\w]+)\b/g, "CREDENTIAL_REDACTED")
    .replace(/([?&](?:access_token|refresh_token|api_key|token)=)[^\s&"<>]+/gi, "$1REDACTED")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function safeValue(value) {
  if (typeof value === "string") return safeText(value);
  if (Array.isArray(value)) return value.map(safeValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [safeText(key), /^(authorization|api[-_]?key|(?:access|refresh|auth|bearer)[-_]?token|cookie|password|secret)$/i.test(key) ? "CREDENTIAL_REDACTED" : safeValue(entry)]));
  return value;
}

/** Buffer lines before redaction so a credential split across chunks cannot leak. */
export function lineSink(emit, maxLine = 256_000) {
  const decoder = new StringDecoder("utf8");
  let pending = "", dropping = false;
  function accept(text) {
    pending += text;
    let at;
    while ((at = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, at); pending = pending.slice(at + 1);
      if (!dropping) emit(line.length > maxLine ? "[oversized output line omitted]" : safeText(line));
      dropping = false;
    }
    if (pending.length > maxLine) { pending = ""; dropping = true; }
  }
  return { write: chunk => accept(decoder.write(chunk)), end() { accept(decoder.end()); if (pending && !dropping) emit(safeText(pending)); pending = ""; } };
}

/** Bounded argv-only subprocess. Descendants are owned by the job's process group. */
export function command(bin, args, { cwd, signal, timeoutMs = 20_000, onLine, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", stdout = "", failure;
    const accept = line => { output += line + "\n"; onLine?.(line); if (output.length > 2_000_000) { failure = new Error("Command output exceeded its limit"); child.kill("SIGKILL"); } };
    const out = lineSink(line => { stdout += line + "\n"; accept(line); }), err = lineSink(accept);
    child.stdout.on("data", out.write); child.stderr.on("data", err.write);
    const abort = () => { failure = new Error("Operation stopped"); child.kill("SIGKILL"); };
    const timer = setTimeout(() => { failure = new Error(`${bin} timed out`); child.kill("SIGKILL"); }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.on("error", error => { failure = error; });
    // A grandchild retaining a pipe must not prevent the worker from exiting.
    // The job supervisor terminates the remaining process group on worker exit.
    child.on("exit", () => { const drain = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, 100); drain.unref(); });
    child.on("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort); out.end(); err.end();
      if (failure) reject(failure); else resolve({ code, output: output.trim(), stdout: stdout.trim() });
    });
  });
}

export async function mustCommand(bin, args, options) {
  const result = await command(bin, args, options);
  if (result.code !== 0) throw new Error(result.output || `${bin} exited ${result.code}`);
  return result.output;
}

export function inputQueue() {
  const values = []; let waiting, ended = false;
  return {
    push(value) { if (ended) return; if (waiting) { waiting({ value, done: false }); waiting = null; } else values.push(value); },
    close() { ended = true; waiting?.({ done: true }); waiting = null; },
    [Symbol.asyncIterator]() { return this; },
    next() { if (values.length) return Promise.resolve({ value: values.shift(), done: false }); if (ended) return Promise.resolve({ done: true }); return new Promise(resolve => { waiting = resolve; }); },
    return() { this.close(); return Promise.resolve({ done: true }); },
  };
}
