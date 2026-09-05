import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { lineSink, safeText } from "./process.mjs";

/** Own one stdio app-server connection, its requests and its subprocess lifetime. */
export class CodexRpc extends EventEmitter {
  constructor({ cwd, bin = "codex", args = ["app-server", "--listen", "stdio://"], onLog = () => {} } = {}) {
    super(); this.pending = new Map(); this.sequence = 0; this.closed = false;
    this.child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdin.on("error", error => this.fail(error));
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", line => {
      if (line.length > 4_000_000) return this.fail(new Error("Codex message exceeded its limit"));
      let message; try { message = JSON.parse(line); } catch { return this.fail(new Error("Codex sent invalid JSON")); }
      if (message.method) this.emit(message.id === undefined ? "notification" : "request", message);
      else {
        const request = this.pending.get(message.id); if (!request) return;
        this.pending.delete(message.id); clearTimeout(request.timer);
        if (message.error) request.reject(new Error(safeText(message.error.message))); else request.resolve(message.result);
      }
    });
    const sink = lineSink(onLog); this.child.stderr.on("data", sink.write);
    this.child.on("error", error => this.fail(error));
    this.child.on("exit", (code, signal) => { sink.end(); if (!this.closed) this.fail(new Error(`Codex disconnected (${signal || code})`)); });
  }
  send(message) { if (this.closed) throw new Error("Codex connection is closed"); this.child.stdin.write(JSON.stringify(message) + "\n"); }
  request(method, params = {}, timeoutMs = 30_000) {
    if (this.closed) return Promise.reject(new Error("Codex connection is closed"));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async initialize() {
    await this.request("initialize", { clientInfo: { name: "rusubon", title: "Rusubon", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    this.send({ method: "initialized", params: {} }); return this;
  }
  async list(method, params = {}) {
    const rows = []; let cursor;
    do { const page = await this.request(method, { ...params, limit: 100, ...(cursor ? { cursor } : {}) }); rows.push(...(page.data || [])); cursor = page.nextCursor; } while (cursor);
    return rows;
  }
  fail(error) {
    if (this.closed) return;
    this.emit("disconnected", error); this.close(error);
  }
  close(error = new Error("Codex connection closed")) {
    if (this.closed) return; this.closed = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear(); this.lines.close(); this.child.stdin.destroy(); this.child.kill("SIGTERM");
    const timer = setTimeout(() => { if (this.child.exitCode === null) this.child.kill("SIGKILL"); }, 1000); timer.unref();
  }
}
