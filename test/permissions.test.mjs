import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { trashFixture } from "./helpers/cleanup.mjs";
import { loadConfig } from "../src/config.mjs";
import { RUNNERS } from "../src/runners.mjs";
import { saveSetup, workspaceState, writeLocal } from "../src/ui/workspace.mjs";
import { Jobs } from "../src/ui/jobs.mjs";
import { startDashboard } from "../src/ui/server.mjs";
import { runCodex, answerCodexRequest } from "../src/ui/codex.mjs";
import { runClaude } from "../src/ui/claude.mjs";
import { jobView } from "../src/ui/web/views.js";

const selection = { runner: "claude", model: "claude-sonnet-5", effort: "high" };
const context = "# Product\nTest product\n# Money paths\n/checkout\n# Intentional friction\nNone\n# Out of scope\nStaging\n";
const input = repo => ({ ...selection, projectId: "123", host: "eu", context, confirmed: true, expectedRevision: workspaceState(repo).revision });
function fixture(t) { const repo = mkdtempSync(join(tmpdir(), "rusubon-permissions-")); t.after(() => trashFixture(repo)); return repo; }
const claudeModes = { auto: "auto", ask: "default", yolo: "bypassPermissions" };
const codexModes = {
  auto: { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write" },
  ask: { approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write" },
  yolo: { approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access" },
};

test("CLI and Setup default existing configs to Auto, preserve explicit modes, and reject invalid values", t => {
  const repo = fixture(t), previous = process.cwd(); process.chdir(repo); t.after(() => process.chdir(previous));
  writeLocal(repo, "rusubon.json", JSON.stringify(selection));
  assert.equal(loadConfig().permissionMode, "auto");
  assert.equal(workspaceState(repo).config.permissionMode, "auto");
  for (const permissionMode of ["auto", "ask", "yolo"]) {
    saveSetup(repo, { ...input(repo), permissionMode });
    assert.equal(loadConfig().permissionMode, permissionMode);
    saveSetup(repo, input(repo));
    assert.equal(workspaceState(repo).config.permissionMode, permissionMode);
  }
  for (const permissionMode of ["", "bypassPermissions", "__proto__", null, true, {}]) {
    const before = readFileSync(join(repo, "rusubon.json"), "utf8");
    assert.throws(() => saveSetup(repo, { ...input(repo), permissionMode }), /Choose Auto, Ask, or YOLO/);
    assert.equal(readFileSync(join(repo, "rusubon.json"), "utf8"), before);
    writeLocal(repo, "rusubon.json", JSON.stringify({ ...selection, permissionMode }));
    assert.throws(loadConfig, /Choose Auto, Ask, or YOLO/);
    assert.deepEqual(workspaceState(repo).config.permissionMode, permissionMode);
  }
  saveSetup(repo, { ...input(repo), permissionMode: "auto" });
  assert.equal(loadConfig().permissionMode, "auto");
});

test("launch API takes the saved permission mode, not a payload override, for every agent job", async t => {
  const repo = fixture(t), jobs = new EventEmitter(), started = [];
  jobs.list = () => [];
  jobs.close = async () => {};
  jobs.start = operation => { started.push(operation); return operation; };
  const app = await startDashboard({ repo, jobs, open: false }); t.after(() => app.close());
  const headers = { "X-Rusubon-Token": app.token, "Content-Type": "application/json" };
  for (const permissionMode of ["auto", "ask", "yolo"]) {
    saveSetup(repo, { ...input(repo), permissionMode });
    for (const kind of ["scout", "context", "pr"]) {
      const response = await fetch(app.origin + "/api/jobs", { method: "POST", headers, body: JSON.stringify({ kind, selection, permissionMode: "yolo", about: "Test product", source: { kind: "issue", value: "#1" } }) });
      assert.equal(response.status, 202);
      assert.equal((await response.json()).permissionMode, permissionMode);
    }
  }
  assert.equal(started[0].permissionMode, "auto");
});

test("Jobs rejects invalid permissions before spawn and records the launch mode in history", async t => {
  const repo = fixture(t), worker = fileURLToPath(new URL("./helpers/ui-worker.mjs", import.meta.url));
  const jobs = new Jobs(repo, { worker }); t.after(() => jobs.close());
  assert.throws(() => jobs.start({ kind: "context", selection, permissionMode: "unknown" }), /Choose Auto/);
  assert.equal(jobs.list().length, 0);
  const job = jobs.start({ kind: "context", selection, permissionMode: "yolo", about: "Fixture" });
  for (let i = 0; jobs.active.size && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(job.status, "completed");
  saveSetup(repo, { ...input(repo), permissionMode: "ask" });
  const restored = new Jobs(repo, { worker }); t.after(() => restored.close());
  const detail = restored.detail(job.id);
  assert.equal(detail.permissionMode, "yolo");
  assert.match(jobView(detail), /YOLO permissions/);
  assert.match(jobView({ ...detail, permissionMode: undefined }), /Ask permissions/);
});

for (const mode of [undefined, "auto", "ask", "yolo"]) test(`Codex adapter applies ${mode || "default Auto"} and leaves user input interactive`, async () => {
  const expected = codexModes[mode || "auto"], calls = [];
  const rpc = new EventEmitter();
  rpc.initialize = async () => {};
  rpc.close = () => {};
  rpc.send = message => { calls.push(message); queueMicrotask(() => rpc.emit("notification", { method: "turn/completed", params: { threadId: "test", turn: { status: "completed" } } })); };
  rpc.request = async (method, params) => {
    if (method === "thread/start") {
      for (const [key, value] of Object.entries(expected)) assert.equal(params[key], value);
      return { thread: { id: "test" }, ...expected, sandbox: { type: mode === "yolo" ? "dangerFullAccess" : "workspaceWrite" } };
    }
    queueMicrotask(() => rpc.emit("request", { id: 1, method: "item/tool/requestUserInput", params: { questions: [{ id: "product" }] } }));
    return {};
  };
  let asked = false;
  const result = await runCodex("Test", { cwd: "/tmp", model: "gpt-5.6-luna", effort: "high", permissionMode: mode, emit: () => {}, createRpc: () => rpc, ask: async request => { asked = true; assert.equal(request.kind, "questions"); return { allow: true, answers: { product: "Checkout" } }; } });
  assert.equal(result.status, 0); assert.ok(asked);
  assert.deepEqual(calls[0].result, { answers: { product: { answers: ["Checkout"] } } });
});

test("Codex refuses a runner that silently ignores the requested reviewer before any turn", async () => {
  const rpc = new EventEmitter(); let turned = false, closed = false;
  rpc.initialize = async () => {};
  rpc.close = () => { closed = true; };
  rpc.request = async method => { if (method === "turn/start") turned = true; return { thread: { id: "test" }, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspaceWrite" } }; };
  await assert.rejects(runCodex("Test", { cwd: "/tmp", model: "gpt-5.6-luna", effort: "high", emit: () => {}, createRpc: () => rpc }), /permission mode/);
  assert.equal(turned, false); assert.ok(closed);
});

for (const mode of [undefined, "auto", "ask", "yolo"]) test(`Claude adapter applies ${mode || "default Auto"} without swallowing questions or explicit denials`, async () => {
  const requests = [];
  const createQuery = ({ options }) => {
    assert.equal(options.permissionMode, claudeModes[mode || "auto"]);
    assert.equal(options.allowDangerouslySkipPermissions, mode === "yolo");
    const stream = (async function* () {
      yield { type: "system", subtype: "init", model: selection.model, effort: "high", permissionMode: options.permissionMode, session_id: "test" };
      const signal = new AbortController().signal;
      const answer = await options.canUseTool("AskUserQuestion", { questions: [{ question: "Product?" }] }, { signal });
      assert.deepEqual(answer.updatedInput.answers, { "Product?": "Checkout" });
      assert.equal((await options.canUseTool("Bash", { command: "blocked action" }, { signal, matchedAskRule: true })).behavior, "deny");
      assert.deepEqual(await options.onElicitation({ message: "Sign in", url: "https://example.com" }, { signal }), { action: "decline" });
      yield { type: "result", subtype: "success", is_error: false };
    })(); stream.close = () => {}; return stream;
  };
  assert.equal((await runClaude("Test", { ...selection, cwd: "/tmp", permissionMode: mode, emit: () => {}, createQuery, ask: async request => { requests.push(request.kind); return { allow: request.kind === "questions", answers: { "Product?": "Checkout" } }; } })).status, 0);
  assert.deepEqual(requests, ["questions", "permission", "elicitation"]);
});

test("MCP tool permission requests use an approval card, while real elicitation retains its schema", async () => {
  const params = { serverName: "posthog", message: "Allow query?", _meta: { codex_approval_kind: "mcp_tool_call", tool_title: "PostHog", tool_params: { command: "info read-data-schema" }, tool_description: "Long documentation" }, requestedSchema: { type: "object", properties: {} } };
  for (const allow of [true, false]) {
    const response = await answerCodexRequest({ method: "mcpServer/elicitation/request", params }, async request => {
      assert.equal(request.kind, "permission");
      assert.deepEqual(request.input, { server: "posthog", tool: "PostHog", arguments: params._meta.tool_params });
      return { allow };
    });
    assert.deepEqual(response, { action: allow ? "accept" : "decline", content: allow ? {} : null });
  }
  const input = { message: "Sign in", url: "https://example.com", requestedSchema: { type: "object" } };
  await answerCodexRequest({ method: "mcpServer/elicitation/request", params: input }, async request => { assert.equal(request.kind, "elicitation"); assert.deepEqual(request.input, input); return { allow: false }; });
});

test("CLI subprocesses receive native Auto defaults and explicit Ask or YOLO flags", t => {
  const repo = fixture(t), capture = join(repo, "arguments.json"), previousPath = process.env.PATH, previousClaude = process.env.RUSUBON_CLAUDE;
  t.after(() => { process.env.PATH = previousPath; if (previousClaude === undefined) delete process.env.RUSUBON_CLAUDE; else process.env.RUSUBON_CLAUDE = previousClaude; });
  for (const bin of ["codex", "claude"]) writeFileSync(join(repo, bin), `#!${process.execPath}\nimport { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
  process.env.PATH = `${repo}:${previousPath}`;
  process.env.RUSUBON_CLAUDE = join(repo, "claude");
  for (const runner of ["codex", "claude"]) for (const mode of [undefined, "auto", "ask", "yolo"]) {
    const result = RUNNERS[runner].run("Test", { permissionMode: mode, timeoutMs: 5000 });
    assert.equal(result.status, 0);
    const args = JSON.parse(readFileSync(capture, "utf8"));
    if (runner === "claude") {
      assert.equal(args[args.indexOf("--permission-mode") + 1], claudeModes[mode || "auto"]);
      assert.equal(args.includes("--allow-dangerously-skip-permissions"), mode === "yolo");
    } else {
      assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), mode === "yolo");
      assert.equal(args.includes("--approve-for-me"), mode === undefined || mode === "auto");
      if (mode === "ask") {
        assert.ok(args.includes('approvals_reviewer="user"'));
        assert.ok(args.includes('approval_policy="on-request"'));
        assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
      }
    }
  }
});
