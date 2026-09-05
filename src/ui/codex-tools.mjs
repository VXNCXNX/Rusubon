import { safeText, safeValue } from "./process.mjs";

const QUIET_WARNING_MS = 60_000, QUIET_TIMEOUT_MS = 180_000;
const bounded = (value, limit) => value.length > limit ? value.slice(0, limit) + "…" : value;

function toolDetail(item) {
  let args = item.arguments;
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { /* Some tools take plain text. */ } }
  args = safeValue(args);
  const command = typeof args?.command === "string" ? args.command.trim().split("\n")[0] : "";
  const name = bounded(safeText(`${item.server} / ${item.tool}${command ? `: ${command}` : ""}`), 180);
  const text = bounded(typeof args === "string" ? args : JSON.stringify(args ?? {}, null, 2), 8000);
  return { type: "tool", callId: item.id, name, text };
}

/** Track MCP silence per call. Model thinking and shell execution have separate limits. */
export class CodexToolActivity {
  constructor(emit, onTimeout) {
    this.emit = emit; this.onTimeout = onTimeout;
    this.calls = new Map(); this.paused = false; this.closed = false;
  }
  clear(call) { clearTimeout(call.warning); clearTimeout(call.deadline); }
  arm(call) {
    this.clear(call);
    if (this.paused || this.closed) return;
    call.warning = setTimeout(() => this.emit({ ...call.detail, status: "waiting", text: "No tool progress for 60 seconds. The run will stop after 180 seconds without progress." }), QUIET_WARNING_MS);
    call.deadline = setTimeout(() => {
      const error = new Error(`${call.detail.name} timed out after 180 seconds without tool progress. The run was stopped; review the connection before retrying.`);
      this.close();
      this.emit({ ...call.detail, status: "timed_out", text: error.message });
      this.onTimeout(error);
    }, QUIET_TIMEOUT_MS);
  }
  item(item, started) {
    if (this.closed) return;
    const detail = toolDetail(item);
    this.emit({ ...detail, status: started ? "running" : item.status || "completed", ...(item.error?.message ? { text: bounded(safeText(item.error.message), 8000) } : {}) });
    if (started) {
      if (this.calls.has(item.id)) return;
      const call = { detail }; this.calls.set(item.id, call); this.arm(call);
    } else {
      const call = this.calls.get(item.id);
      if (call) this.clear(call);
      this.calls.delete(item.id);
    }
  }
  progress({ itemId, message }) {
    const call = this.calls.get(itemId);
    if (!call || this.closed) return;
    this.arm(call);
    this.emit({ ...call.detail, status: "running", text: bounded(safeText(message), 8000) });
  }
  pause() { this.paused = true; for (const call of this.calls.values()) this.clear(call); }
  resume() { this.paused = false; for (const call of this.calls.values()) this.arm(call); }
  close() { this.closed = true; for (const call of this.calls.values()) this.clear(call); this.calls.clear(); }
}
