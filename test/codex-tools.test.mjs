import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { runCodex } from "../src/ui/codex.mjs";
import { activityView } from "../src/ui/web/views.js";

const stalled = { id: "schema", type: "mcpToolCall", server: "rusubon-posthog", tool: "exec", status: "inProgress", arguments: { command: "info read-data-schema", context: "Check event schema" } };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

async function harness(t, options = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rpc = new EventEmitter(), events = [], replies = [], controller = new AbortController();
  let outcome, closed = false;
  rpc.initialize = async () => {};
  rpc.close = () => { closed = true; };
  rpc.send = message => replies.push(message);
  rpc.request = async method => method === "thread/start" ? { thread: { id: "test" }, approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: { type: "workspaceWrite" } } : {};
  const done = runCodex("Scout", { cwd: "/tmp", model: "gpt-5.6-luna", effort: "high", signal: controller.signal, emit: event => events.push(event), createRpc: () => rpc, ...options })
    .then(result => { outcome = result; }, error => { outcome = error; });
  t.after(async () => { controller.abort(); await done; });
  await flush();
  const notify = (method, params = {}) => rpc.emit("notification", { method, params: { threadId: "test", ...params } });
  return { rpc, events, replies, notify, controller, get outcome() { return outcome; }, get closed() { return closed; }, async tick(ms) { t.mock.timers.tick(ms); await flush(); } };
}

test("PostHog exec activity exposes the actual operation and redacts structured arguments", async t => {
  const h = await harness(t);
  h.notify("item/started", { item: { ...stalled, arguments: { ...stalled.arguments, password: "private-value", api_key: "private-key" } } });
  const event = h.events.find(row => row.type === "tool");
  assert.match(event.name, /rusubon-posthog.*info read-data-schema/);
  assert.match(event.text, /info read-data-schema/);
  assert.doesNotMatch(JSON.stringify(event), /private-value|private-key/);
  assert.match(activityView({ events: [{ ...event, sequence: 1 }] }), /<summary>[^<]*info read-data-schema/);
});

test("a stalled MCP call warns after one minute and fails after three with the operation", async t => {
  const h = await harness(t);
  h.notify("item/started", { item: stalled });
  await h.tick(60_000);
  assert.ok(h.events.some(row => row.status === "waiting" && /info read-data-schema/.test(row.name)));
  await h.tick(120_000);
  assert.match(h.outcome?.message || "", /info read-data-schema.*180 seconds/);
  assert.ok(h.closed);
  assert.ok(h.events.some(row => row.status === "timed_out"));
});

test("MCP progress is visible, resets only its own deadline, and completion clears it", async t => {
  const h = await harness(t);
  h.notify("item/started", { item: stalled });
  await h.tick(120_000);
  h.notify("item/mcpToolCall/progress", { itemId: stalled.id, message: "Loading schema" });
  assert.ok(h.events.some(row => row.text === "Loading schema"));
  await h.tick(120_000);
  assert.equal(h.outcome, undefined);
  h.notify("item/completed", { item: { ...stalled, status: "completed" } });
  await h.tick(180_000);
  assert.equal(h.outcome, undefined);
  h.notify("turn/completed", { turn: { status: "completed" } });
  await flush();
  assert.equal(h.outcome.status, 0);
});

test("waiting for human input pauses tool deadlines, including calls started while waiting", async t => {
  const answers = [];
  const h = await harness(t, { ask: () => new Promise(resolve => answers.push(resolve)) });
  h.notify("item/started", { item: stalled });
  await h.tick(120_000);
  for (const id of [1, 2]) h.rpc.emit("request", { id, method: "item/commandExecution/requestApproval", params: {} });
  h.notify("item/started", { item: { ...stalled, id: "second" } });
  await h.tick(240_000);
  assert.equal(h.outcome, undefined);
  answers[0]({ allow: true }); await flush();
  await h.tick(240_000);
  assert.equal(h.outcome, undefined);
  answers[1]({ allow: true }); await flush();
  await h.tick(179_999);
  assert.equal(h.outcome, undefined);
  await h.tick(1);
  assert.match(h.outcome.message, /info read-data-schema/);
});

test("other tool traffic, usage and another thread cannot mask a stalled MCP call", async t => {
  const h = await harness(t);
  h.notify("item/started", { item: stalled });
  await h.tick(120_000);
  h.notify("item/started", { item: { ...stalled, id: "other" } });
  h.notify("item/completed", { item: { ...stalled, id: "other", status: "completed" } });
  h.notify("item/mcpToolCall/progress", { threadId: "unrelated", itemId: stalled.id, message: "Unrelated" });
  h.notify("thread/tokenUsage/updated", { tokenUsage: {} });
  await h.tick(60_000);
  assert.match(h.outcome.message, /info read-data-schema/);
});

test("reasoning and shell commands keep their existing run limit, and Stop clears tool timers", async t => {
  const h = await harness(t);
  h.notify("item/started", { item: { id: "shell", type: "commandExecution", command: "npm test" } });
  await h.tick(240_000);
  assert.equal(h.outcome, undefined);
  h.notify("item/started", { item: stalled });
  h.controller.abort(); await flush();
  assert.match(h.outcome.message, /Run stopped/);
  const count = h.events.length;
  await h.tick(240_000);
  assert.equal(h.events.length, count);
});

test("serialized arguments and tool errors stay redacted and bounded", async t => {
  const h = await harness(t);
  h.notify("item/started", { item: { ...stalled, arguments: JSON.stringify({ command: "info <schema>", secret: "private-secret", context: "x".repeat(10_000) }) } });
  const event = h.events.at(-1);
  assert.match(event.text, /CREDENTIAL_REDACTED/);
  assert.doesNotMatch(event.text, /private-secret/);
  assert.ok(event.text.length <= 8001);
  assert.match(activityView({ events: [{ ...event, sequence: 1 }] }), /info &lt;schema&gt;/);
  h.notify("item/completed", { item: { ...stalled, status: "failed", error: { message: "Bearer credential" } } });
  assert.equal(h.events.at(-1).text, "Bearer REDACTED");
  await h.tick(180_000);
  assert.equal(h.outcome, undefined);
});

for (const end of ["complete", "disconnect", "overall timeout"]) test(`${end} clears every active tool deadline`, async t => {
  const h = await harness(t, end === "overall timeout" ? { timeoutMs: 30_000 } : {});
  h.notify("item/started", { item: stalled });
  if (end === "complete") h.notify("turn/completed", { turn: { status: "completed" } });
  else if (end === "disconnect") h.rpc.emit("disconnected", new Error("Connection lost"));
  else await h.tick(30_000);
  await flush();
  assert.ok(h.closed);
  if (end === "complete") assert.equal(h.outcome.status, 0);
  if (end === "disconnect") assert.equal(h.outcome.message, "Connection lost");
  if (end === "overall timeout") assert.equal(h.outcome.timedOut, true);
  const count = h.events.length;
  await h.tick(180_000);
  assert.equal(h.events.length, count);
});
