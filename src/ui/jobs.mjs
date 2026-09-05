import { EventEmitter } from "node:events";
import { fork, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { acquireRepoLock } from "../lock.mjs";
import { localPath, readJsonLocal, readRawLocal, writeLocal } from "./workspace.mjs";
import { lineSink, safeText, safeValue } from "./process.mjs";
import { DRAFT_GUARD } from "../context.mjs";
import { sealDraft } from "../context-draft.mjs";

const WORKER = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const WATCHDOG = fileURLToPath(new URL("./watchdog.mjs", import.meta.url));
const TERMINAL = new Set(["completed", "failed", "stopped", "needs_attention"]);
export const terminalJob = job => TERMINAL.has(job.status);

/** Persist jobs independently of browser connections; own all writable workflow processes. */
export class Jobs extends EventEmitter {
  constructor(repo, { worker = WORKER } = {}) {
    super(); this.repo = repo; this.worker = worker; this.active = new Map(); this.jobs = new Map();
    const dir = localPath(repo, ".rusubon/runs");
    if (existsSync(dir)) for (const name of readdirSync(dir).filter(name => /^ui-[a-f0-9-]+$/.test(name))) {
      try { const job = readJsonLocal(repo, `.rusubon/runs/${name}/job.json`);
        if (job.id !== name) continue;
        if (!terminalJob(job)) { job.status = "failed"; job.error = "The dashboard stopped during this run. Partial work is preserved."; job.requests = []; job.finishedAt = new Date().toISOString(); this.persist(job); }
        this.jobs.set(job.id, job);
      } catch { /* Unreadable history is not treated as a completed run. */ }
    }
    // Recovery owns the same mutation lock as all new workflows. A durable
    // guard blocks scouting even if both the worker and dashboard were killed.
    if (existsSync(localPath(repo, DRAFT_GUARD))) {
      const release = acquireRepoLock(repo);
      try { this.recoverContext(); } finally { release(); }
    }
  }
  recoverContext(id) {
    const guardPath = localPath(this.repo, DRAFT_GUARD);
    if (!existsSync(guardPath)) return;
    const guard = readJsonLocal(this.repo, DRAFT_GUARD);
    if (id && guard.id !== id) throw new Error("Context draft recovery belongs to another run");
    if (Number.isInteger(guard.workerPid) && guard.workerPid > 1) {
      let alive = true;
      try { process.kill(-guard.workerPid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; }
      if (alive) { const error = new Error("The previous context draft is still stopping. Its context remains unconfirmed."); error.code = "CONTEXT_DRAFT_STOPPING"; throw error; }
    }
    const context = readRawLocal(this.repo, ".rusubon/context.md");
    writeLocal(this.repo, ".rusubon/context.md", sealDraft(context));
    unlinkSync(guardPath);
  }
  persist(job) { writeLocal(this.repo, `.rusubon/runs/${job.id}/job.json`, JSON.stringify(job, null, 2) + "\n"); }
  list() { return [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)); }
  get(id) { const job = this.jobs.get(id); if (!job) throw new Error("Run not found"); return job; }
  detail(id) {
    const job = this.get(id);
    const text = readRawLocal(this.repo, `.rusubon/runs/${id}/events.jsonl`, "", 35_000_000);
    const events = text.split("\n").filter(Boolean).slice(-600).flatMap(line => { try { return [safeValue(JSON.parse(line))]; } catch { return []; } });
    return { ...job, events };
  }
  start(input) {
    if (process.platform === "win32") throw new Error("Use WSL for supervised agent runs on Windows");
    const release = acquireRepoLock(this.repo);
    try { this.recoverContext(); } catch (error) { release(); throw error; }
    const id = `ui-${randomUUID()}`;
    const job = { id, kind: input.kind, selection: input.selection, specSelection: input.specSelection, scoutScope: input.scoutScope, source: input.source || null, status: "starting", startedAt: new Date().toISOString(), requests: [], eventCount: 0, logBytes: 0 };
    let child;
    try {
      this.persist(job); this.jobs.set(id, job);
      if (input.kind === "context") writeLocal(this.repo, DRAFT_GUARD, JSON.stringify({ id }) + "\n");
      child = fork(this.worker, [], { cwd: this.repo, detached: true, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] });
      if (input.kind === "context") writeLocal(this.repo, DRAFT_GUARD, JSON.stringify({ id, workerPid: child.pid }) + "\n");
      const watchdog = spawn(process.execPath, [WATCHDOG, String(process.pid), String(child.pid)], { detached: true, stdio: "ignore" }); watchdog.unref();
      watchdog.on("error", () => this.stop(id));
      const output = text => { if (text.trim()) this.record(job, { type: "log", text }); };
      const out = lineSink(output), err = lineSink(output);
      child.stdout.on("data", out.write); child.stderr.on("data", err.write);
      let settled;
      const done = new Promise(resolve => { settled = resolve; });
      this.active.set(id, { child, release, killTimer: null, done });
      child.on("message", message => this.receive(job, message));
      child.on("error", error => { job.error = safeText(error.message); });
      child.on("exit", async (code, signal) => {
        out.end(); err.end(); const active = this.active.get(id); if (!active) return;
        clearTimeout(active.killTimer);
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
        if (job.kind === "context") {
          try { await this.waitForContextRecovery(id); }
          catch (error) { job.status = "failed"; job.error = `Context recovery failed: ${safeText(error.message)}`; }
        }
        this.active.delete(id); release();
        if (!terminalJob(job)) { job.status = job.status === "stopping" ? "stopped" : "failed"; job.error ||= `Runner exited before completing (${signal || code})`; }
        job.requests = []; job.finishedAt ||= new Date().toISOString();
        try { this.persist(job); this.emit("change", id); } finally { settled(); }
      });
      child.send({ type: "start", input: { ...input, id } }); this.emit("change", id); return job;
    } catch (error) { child?.kill("SIGKILL"); release(); throw error; }
  }
  async waitForContextRecovery(id) {
    for (let attempt = 0; ; attempt++) {
      try { this.recoverContext(id); return; }
      catch (error) {
        if (error.code !== "CONTEXT_DRAFT_STOPPING" || attempt >= 20) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }
  record(job, event) {
    const safe = safeValue(event);
    const entry = { ...safe, sequence: ++job.eventCount, at: new Date().toISOString() };
    const line = JSON.stringify(entry) + "\n";
    if (job.logBytes + line.length <= 32_000_000) { appendFileSync(localPath(this.repo, `.rusubon/runs/${job.id}/events.jsonl`), line, { mode: 0o600 }); job.logBytes += line.length; }
    else job.logTruncated = true;
    if (event.type === "phase") job.phase = entry;
    if (event.type === "worktree") job.worktree = entry.path;
    if (event.type === "artifacts") job.workflowArtifacts = entry;
    if (event.type === "scope") job.scoutScope = entry.scope;
    this.persist(job); this.emit("change", job.id);
  }
  receive(job, message) {
    if (terminalJob(job)) return;
    if (message.type === "event") this.record(job, message.event);
    if (message.type === "request") { job.requests.push(safeValue(message.request)); job.status = "waiting"; this.persist(job); this.emit("change", job.id); }
    if (message.type === "request_closed") { job.requests = job.requests.filter(row => row.id !== message.id); if (!job.requests.length && job.status === "waiting") job.status = "running"; this.persist(job); this.emit("change", job.id); }
    if (message.type === "started") { job.status = "running"; this.persist(job); this.emit("change", job.id); }
    if (message.type === "result") {
      job.status = job.status === "stopping" ? "stopped" : message.error ? "failed" : message.result?.verdict === "requires_human_input" || message.result?.timedOut || message.result?.mcp === "missing" ? "needs_attention" : "completed";
      job.error = safeText(message.error || ""); job.result = safeValue(message.result || {});
      job.finishedAt = new Date().toISOString(); job.requests = []; this.persist(job); this.emit("change", job.id);
    }
  }
  answer(id, requestId, response) {
    const job = this.get(id), active = this.active.get(id);
    if (!active || !job.requests.some(request => request.id === requestId) || job.status !== "waiting") throw new Error("This request is no longer pending");
    if (typeof response?.allow !== "boolean") throw new Error("Choose allow or decline");
    active.child.send({ type: "answer", id: requestId, response });
    job.requests = job.requests.filter(request => request.id !== requestId); job.status = job.requests.length ? "waiting" : "running"; this.persist(job); this.emit("change", id);
  }
  stop(id) {
    const job = this.get(id), active = this.active.get(id); if (!active) return job;
    if (!terminalJob(job)) { job.status = "stopping"; job.requests = []; this.persist(job); this.emit("change", id); }
    if (active.child.connected) active.child.send({ type: "stop" });
    clearTimeout(active.killTimer);
    active.killTimer = setTimeout(() => { try { process.kill(-active.child.pid, "SIGKILL"); } catch {} }, 1500);
    return job;
  }
  async close() { const pending = [...this.active.values()].map(active => active.done); for (const id of this.active.keys()) this.stop(id); await Promise.all(pending); }
}

/** Read-only runner discovery has a separate worker and cannot change process.cwd in the server. */
export function probe(repo, runner, timeoutMs = 40_000) {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, [], { cwd: repo, detached: true, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
    let answered = false;
    const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
    const timer = setTimeout(() => { if (!answered) reject(new Error("Connection check timed out")); answered = true; stop(); }, timeoutMs);
    child.on("message", message => { if (message.type !== "probe_result" || answered) return; answered = true; clearTimeout(timer); stop(); if (message.error) reject(new Error(safeText(message.error))); else resolve(message.result); });
    child.on("error", error => { if (!answered) reject(error); answered = true; clearTimeout(timer); stop(); });
    child.on("exit", () => { clearTimeout(timer); if (!answered) reject(new Error("Connection check exited unexpectedly")); });
    child.send({ type: "probe", runner });
  });
}
