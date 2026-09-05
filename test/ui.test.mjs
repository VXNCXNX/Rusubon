import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { get } from "node:http";
import { spawn } from "node:child_process";
import { trashFixture } from "./helpers/cleanup.mjs";
import { MODEL_ALLOWLIST, SPEC_MODEL_ALLOWLIST, ROLE_MODELS, availableModels, validateSelection, validateSavedSelection } from "../src/ui/models.mjs";
import { localPath, saveSetup as saveSetupAtRevision, workspaceState, renderMarkdown, writeLocal } from "../src/ui/workspace.mjs";
import { lineSink, safeText, safeValue } from "../src/ui/process.mjs";
import { Jobs, terminalJob } from "../src/ui/jobs.mjs";
import { startDashboard } from "../src/ui/server.mjs";
import { CodexRpc } from "../src/ui/codex-rpc.mjs";
import { answerCodexRequest } from "../src/ui/codex.mjs";
import { acquireRepoLock } from "../src/lock.mjs";
import { runSkill } from "../src/run.mjs";
import { candidatesRel } from "../src/candidates.mjs";
import { initConfig, loadConfig } from "../src/config.mjs";
import { draftContext } from "../src/context-draft.mjs";
import { posthogMcpOk } from "../src/doctor.mjs";
import { artifacts } from "../src/ui/artifacts.mjs";
import { fixture as prFixture } from "./helpers/pr-fixture.mjs";
import { git } from "../skills/spec/scripts/evidence.mjs";
import { preparePr } from "../src/ui/pr-worktree.mjs";
import { assertClaudeSelection, claudeOptions, isOfficialPosthog } from "../src/ui/claude.mjs";
import { modelControls, jobView } from "../src/ui/web/views.js";

const worker = fileURLToPath(new URL("./helpers/ui-worker.mjs", import.meta.url));
const selection = { runner: "claude", model: "claude-sonnet-5", effort: "high" };
const saveSetup = (repo, input) => saveSetupAtRevision(repo, { expectedRevision: workspaceState(repo).revision, ...input });
const context = "# Product\nTest product.\n\n# Money paths\n/checkout\n\n# Intentional friction\nPaywall.\n\n# Out of scope\nStaging.\n";
function fixture(t) { const repo = mkdtempSync(join(tmpdir(), "rusubon-ui-")); t.after(() => trashFixture(repo)); return repo; }
async function waitFor(predicate, timeout = 8000) { const deadline = Date.now() + timeout; while (!predicate()) { if (Date.now() > deadline) throw new Error("Condition timed out"); await new Promise(resolve => setTimeout(resolve, 25)); } }
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const catalog = runner => MODEL_ALLOWLIST[runner].map(row => runner === "claude" ? { resolvedModel: row.id + (row.id.includes("opus") ? "[1m]" : ""), supportedEffortLevels: row.efforts } : { model: row.id, supportedReasoningEfforts: row.efforts.map(reasoningEffort => ({ reasoningEffort })), defaultReasoningEffort: row.defaultEffort });

test("model choices intersect live capabilities and never offer Fable, aliases or invented efforts", () => {
  assert.equal(Object.values(MODEL_ALLOWLIST).flat().length, 6);
  for (const runner of ["claude", "codex"]) {
    const live = availableModels(runner, catalog(runner));
    assert.ok(live.every(row => row.available));
    for (const row of live) for (const effort of row.efforts) assert.equal(validateSelection({ runner, model: row.id, effort }, live).effort, effort);
    assert.ok(availableModels(runner, []).every(row => !row.available && !row.efforts.length));
  }
  assert.throws(() => validateSavedSelection({ runner: "claude", model: "claude-fable-5", effort: "low" }));
  assert.throws(() => validateSavedSelection({ runner: "claude", model: "default", effort: "high" }));
  for (const model of ["claude-opus-5", "claude-sonnet-5", "gpt-5.6-luna"]) assert.throws(() => validateSavedSelection({ runner: model.startsWith("gpt") ? "codex" : "claude", model, effort: "ultra" }));
  const narrowed = availableModels("codex", [{ model: "gpt-6-astra", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }]);
  assert.throws(() => validateSelection({ runner: "codex", model: "gpt-6-astra", effort: "ultra" }, narrowed));
  assert.deepEqual(narrowed.at(-1).efforts, ["low"]);
});

test("Fable 5.1 is live-checked and restricted to spec creation, with independent role pickers", () => {
  const fable = { runner: "claude", model: "claude-fable-5-1", effort: "max" };
  const live = availableModels("claude", [...catalog("claude"), { resolvedModel: fable.model, supportedEffortLevels: ["low", "high", "max"] }], "spec");
  assert.deepEqual(validateSelection(fable, live, "spec"), fable);
  assert.deepEqual(live.at(-1).efforts, ["low", "high", "max"]);
  for (const role of ["scout", "implementation"]) assert.throws(() => validateSelection(fable, live, role));
  assert.throws(() => validateSelection({ ...fable, effort: "xhigh" }, live, "spec"));
  for (const model of ["claude-fable-5", "fable", "claude-fable-5.1"]) assert.throws(() => validateSavedSelection({ ...fable, model }, "spec"));
  assert.throws(() => validateSavedSelection({ ...fable, effort: "ultra" }, "spec"));
  const state = { jobs: [], roleModels: ROLE_MODELS, connections: { claude: { authenticated: true, models: live } } };
  assert.match(modelControls(state, fable, "spec"), /Fable 5.1/);
  for (const role of ["scout", "implementation"]) assert.doesNotMatch(modelControls(state, selection, role), /Fable|fable/);
  assert.ok(availableModels("claude", catalog("claude"), "spec").find(row => row.id === fable.model).available === false);
});

test("Claude refuses reported effort drift, parent model switches and fallback events", () => {
  const selected = { model: "claude-fable-5-1", effort: "max" };
  assert.doesNotThrow(() => assertClaudeSelection({ type: "system", subtype: "init", model: selected.model, effort: "max" }, selected));
  assert.throws(() => assertClaudeSelection({ type: "system", subtype: "init", model: selected.model, effort: "low" }, selected), /effort instead of max/);
  assert.throws(() => assertClaudeSelection({ type: "assistant", message: { model: "claude-opus-5" } }, selected), /instead of/);
  assert.throws(() => assertClaudeSelection({ type: "system", subtype: "model_refusal_fallback", fallback_model: "claude-fable-5-1" }, selection), /fell back/);
  assert.deepEqual(claudeOptions("/tmp").settings.fallbackModel, []);
});

test("PostHog preflight rejects disconnected, pending, and failed states", () => {
  for (const status of ["not connected", "disconnected", "pending", "failed to connect", "error: previously connected"]) assert.equal(posthogMcpOk(`posthog: ${status}`), false);
  assert.equal(posthogMcpOk("posthog: connected"), true);
  assert.equal(posthogMcpOk("posthog-old: disconnected\nposthog: connected"), true);
  assert.equal(isOfficialPosthog("https://mcp.posthog.com/mcp"), true);
  for (const url of ["http://mcp.posthog.com/mcp", "https://mcp.posthog.com:8443/mcp", "https://mcp.posthog.com.evil.test/mcp", "https://user:pass@mcp.posthog.com/mcp"]) assert.equal(isOfficialPosthog(url), false);
});

test("setup preserves human confirmation and existing config, rejects invalid models and credentials", t => {
  const repo = fixture(t), input = { ...selection, projectId: "123", host: "eu", context, confirmed: false };
  writeLocal(repo, "rusubon.json", JSON.stringify({ retained: { apiKey: "existing-secret" } }));
  saveSetup(repo, input);
  assert.equal(workspaceState(repo).confirmed, false);
  assert.match(readFileSync(join(repo, ".rusubon/context.md"), "utf8"), /RUSUBON_CONTEXT_PLACEHOLDER/);
  saveSetup(repo, { ...input, confirmed: true });
  assert.equal(workspaceState(repo).confirmed, true);
  assert.equal(JSON.parse(readFileSync(join(repo, "rusubon.json"))).retained.apiKey, "existing-secret");
  assert.throws(() => saveSetup(repo, { ...input, context: context + "phc_sensitiveValue" }), /credentials/);
  assert.throws(() => saveSetup(repo, { ...input, confirmed: true, context: "# Product\nUnknown" }), /headings/);
  assert.throws(() => saveSetup(repo, { ...input, projectId: "whatever" }), /number/);
});

test("saved scout, spec and implementation defaults remain independent across reloads", t => {
  const repo = fixture(t), original = process.cwd(); process.chdir(repo); t.after(() => process.chdir(original));
  const spec = { runner: "claude", model: "claude-fable-5-1", effort: "max" }, implementation = { runner: "codex", model: "gpt-5.6-luna", effort: "medium" };
  const input = { ...selection, spec, implementation, projectId: "123", host: "eu", context, confirmed: true };
  saveSetup(repo, input);
  saveSetup(repo, { ...input, runner: "codex", model: "gpt-5.6-terra", effort: "low", spec: undefined, implementation: undefined });
  const loaded = loadConfig();
  assert.equal(loaded.model, "gpt-5.6-terra"); assert.deepEqual(loaded.spec, spec); assert.deepEqual(loaded.implementation, implementation);
  assert.deepEqual(workspaceState(repo).config.spec, spec); assert.deepEqual(workspaceState(repo).config.implementation, implementation);
  assert.throws(() => saveSetup(repo, { ...input, implementation: spec }));
  assert.deepEqual(loadConfig().implementation, implementation);
});

test("workspace boundary rejects traversal and existing or broken symlinks; markdown cannot execute", t => {
  const repo = fixture(t);
  assert.throws(() => localPath(repo, "../outside")); assert.throws(() => localPath(repo, "/etc/passwd"));
  symlinkSync("/path-that-does-not-exist", join(repo, "broken"));
  assert.throws(() => writeLocal(repo, "broken/file", "unsafe"), /symbolic/);
  symlinkSync(repo, join(repo, "alias")); assert.throws(() => localPath(repo, "alias/file"));
  const html = renderMarkdown('<script>alert(1)</script>\n[bad](javascript:alert)\n<img src=x onerror=alert(1)>\n\n[ok](https://example.com)\n\n| a | b |\n| - | - |\n| 1 | 2 |');
  assert.doesNotMatch(html, /script|javascript:|onerror|<img/); assert.match(html, /noopener noreferrer/); assert.match(html, /<table>/);
});

test("credential filtering survives chunk boundaries and JSON punctuation", () => {
  const lines = [], sink = lineSink(line => lines.push(line));
  sink.write(Buffer.from("Authorization: Bear")); sink.write(Buffer.from("er abc123\nphc_")); sink.write(Buffer.from("sensitiveSecret\n")); sink.end();
  assert.doesNotMatch(lines.join("\n"), /abc123|sensitiveSecret/);
  const value = safeValue({ message: 'Bearer abc123', nested: { password: "plain-secret" }, list: ["phx_abcdef"], phc_keySecret: true });
  assert.equal(JSON.parse(JSON.stringify(value)).message, "Bearer REDACTED");
  assert.doesNotMatch(JSON.stringify(value), /plain-secret|abcdef|abc123|keySecret/);
  assert.equal(safeText("sk-ant-longprivatekey"), "CREDENTIAL_REDACTED");
});

test("shared locks exclude CLI/UI overlap and recover a dead owner", t => {
  const repo = fixture(t), release = acquireRepoLock(repo);
  assert.throws(() => acquireRepoLock(repo), /already active/); release();
  writeFileSync(join(repo, ".rusubon/runs/run.lock"), JSON.stringify({ pid: 2147483647, id: "dead" }));
  acquireRepoLock(repo)(); assert.equal(existsSync(join(repo, ".rusubon/runs/run.lock")), false);
  symlinkSync("/path-that-does-not-exist", join(repo, ".rusubon/runs/run.lock"));
  assert.throws(() => acquireRepoLock(repo), /unreadable/);
});

test("locking a previously initialized repository does not dirty its checkout", t => {
  const f = prFixture(); t.after(() => f.cleanup());
  const release = acquireRepoLock(f.repo); t.after(release);
  assert.equal(git(f.repo, ["status", "--porcelain"]), "");
});

test("PR preparation isolates committed code and evidence while preserving dirty original files", async t => {
  const f = prFixture(); t.after(() => f.cleanup());
  const original = readFileSync(join(f.repo, "retry.mjs"), "utf8");
  writeFileSync(join(f.repo, "retry.mjs"), "// work in progress\n");
  const events = [];
  const { worktree, base } = await preparePr(f.repo, { kind: "report", value: "retry" }, "ui-deadbeef", { worktreeRoot: join(f.root, "worktrees"), emit: event => events.push(event) });
  assert.equal(base, "main");
  assert.equal(readFileSync(join(worktree, "retry.mjs"), "utf8"), original);
  assert.equal(readFileSync(join(f.repo, "retry.mjs"), "utf8"), "// work in progress\n");
  assert.equal(git(f.repo, ["branch", "--show-current"]), "main");
  assert.match(git(worktree, ["branch", "--show-current"]), /^codex-ui-base-/);
  assert.match(readFileSync(join(worktree, ".rusubon/inbox/reports/retry.md"), "utf8"), /5 users/);
  assert.equal(git(worktree, ["status", "--porcelain"]), "");
  assert.equal(events.at(-1).status, "completed");
});

test("jobs retain requests across reads, redact persisted data, settle answers and recover history", async t => {
  const repo = fixture(t), jobs = new Jobs(repo, { worker }); t.after(() => jobs.close());
  const job = jobs.start({ kind: "scout", selection });
  assert.throws(() => jobs.start({ kind: "scout", selection }), /already active/);
  await waitFor(() => job.status === "waiting");
  assert.equal(jobs.detail(job.id).requests[0].id, "approval-1");
  assert.equal(jobs.detail(job.id).requests[0].id, "approval-1");
  assert.doesNotMatch(readFileSync(join(repo, `.rusubon/runs/${job.id}/job.json`), "utf8"), /secret-value/);
  assert.doesNotMatch(JSON.stringify(jobs.detail(job.id)), /secret-value|fakeSecretValue/);
  await jobs.answer(job.id, "approval-1", { allow: true });
  await assert.rejects(jobs.answer(job.id, "approval-1", { allow: true }), /no longer pending/);
  await waitFor(() => terminalJob(job) && !jobs.active.size);
  assert.equal(job.status, "completed");
  assert.ok(artifacts(repo, jobs.detail(job.id)).some(row => row.key === "Run/close-out.md"));
  const reloaded = new Jobs(repo, { worker }); assert.equal(reloaded.detail(job.id).status, "completed");
  assert.ok(reloaded.detail(job.id).events.some(event => event.text?.includes("Query approved")));
});

test("stopping a job terminates a stubborn worker and its descendant", async t => {
  const repo = fixture(t), jobs = new Jobs(repo, { worker }); t.after(() => jobs.close());
  const job = jobs.start({ kind: "pr", selection, source: { kind: "issue", value: "#1" } });
  await waitFor(() => existsSync(join(repo, "descendant.pid")));
  const pid = Number(readFileSync(join(repo, "descendant.pid"), "utf8")); assert.ok(alive(pid));
  jobs.stop(job.id); await waitFor(() => job.status === "stopped" && !alive(pid) && !jobs.active.size);
  assert.equal(existsSync(join(repo, ".rusubon/runs/run.lock")), false);
});

test("server process loss terminates detached workers and their descendants", async t => {
  const repo = fixture(t);
  const parent = spawn(process.execPath, [fileURLToPath(new URL("./helpers/ui-parent.mjs", import.meta.url))], { cwd: repo, stdio: "ignore" });
  t.after(() => { if (parent.exitCode === null) parent.kill("SIGKILL"); });
  await waitFor(() => existsSync(join(repo, "descendant.pid")));
  const childPid = Number(readFileSync(join(repo, "worker.pid"), "utf8"));
  const descendantPid = Number(readFileSync(join(repo, "descendant.pid"), "utf8"));
  assert.ok(alive(childPid) && alive(descendantPid));
  parent.kill("SIGKILL"); await once(parent, "exit");
  await waitFor(() => !alive(childPid) && !alive(descendantPid));
});

test("unexpected worker exits fail visibly, and interrupted history is never marked complete", async t => {
  const repo = fixture(t), jobs = new Jobs(repo, { worker }); t.after(() => jobs.close());
  const job = jobs.start({ kind: "login", runner: "claude" });
  await waitFor(() => job.status === "failed"); assert.match(job.error, /before completing/);
  writeLocal(repo, ".rusubon/runs/ui-dead/job.json", JSON.stringify({ id: "ui-dead", status: "running", requests: [{ id: "old" }], startedAt: new Date().toISOString() }));
  const restored = new Jobs(repo, { worker }).get("ui-dead");
  assert.equal(restored.status, "failed"); assert.deepEqual(restored.requests, []);
});

test("HTTP authenticates every API, rejects cross-origin writes, serves assets, streams changes and runs jobs", async t => {
  const repo = fixture(t), jobs = new Jobs(repo, { worker });
  const app = await startDashboard({ repo, jobs, open: false, probeRunner: async (_repo, runner) => ({ runner, authenticated: true, models: availableModels(runner, catalog(runner)), mcp: [] }) });
  t.after(() => app.close());
  const headers = { "X-Rusubon-Token": app.token, "Content-Type": "application/json" };
  const request = (path, data) => fetch(app.origin + path, { headers, ...(data ? { method: "POST", body: JSON.stringify(data) } : {}) });
  assert.equal((await fetch(app.origin + "/api/state")).status, 401);
  assert.equal((await fetch(app.origin + "/api/jobs", { method: "POST", headers: { ...headers, Origin: "https://attacker.example" }, body: '{"kind":"init"}' })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => get(app.origin + "/api/state", { headers: { ...headers, Host: "attacker.example" } }, res => { res.resume(); resolve(res.statusCode); }).on("error", reject));
  assert.equal(hostStatus, 403);
  for (const asset of ["/", "/app.js", "/views.js", "/requests.js", "/app.css"]) { const r = await fetch(app.origin + asset); assert.equal(r.status, 200); assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/); await r.text(); }
  assert.equal((await request("/api/jobs", { kind: "scout", selection: { ...selection, model: "claude-fable-5" } })).status, 400);
  const specSelection = { runner: "claude", model: "claude-fable-5-1", effort: "max" };
  assert.equal((await request("/api/jobs", { kind: "scout", selection: specSelection })).status, 400);
  assert.equal((await request("/api/jobs", { kind: "pr", selection: specSelection, specSelection, source: { kind: "issue", value: "#1" } })).status, 400);
  assert.equal((await request("/api/jobs", { kind: "pr", selection, source: { kind: "report", value: "../private" } })).status, 400);
  assert.equal((await request("/api/jobs", { kind: "arbitrary" })).status, 400);
  const abort = new AbortController(); const stream = await fetch(app.origin + "/api/events", { headers, signal: abort.signal }); const reader = stream.body.getReader(); assert.match(new TextDecoder().decode((await reader.read()).value), /data:/); abort.abort();
  await assert.rejects(startDashboard({ repo, open: false }), /already running/);
  const response = await request("/api/jobs", { kind: "scout", selection }); assert.equal(response.status, 202); const job = await response.json();
  await waitFor(() => jobs.get(job.id).status === "waiting");
  assert.equal((await request(`/api/jobs/${job.id}/answer`, { requestId: "approval-1", response: { allow: false } })).status, 200);
  await waitFor(() => terminalJob(jobs.get(job.id)));
  const detail = await (await request(`/api/jobs/${job.id}`)).json(); assert.equal(detail.status, "completed");
  const artifact = await (await request(`/api/jobs/${job.id}/artifact?key=Run%2Fclose-out.md`)).json(); assert.match(artifact.html, /No qualifying findings/);
  assert.equal((await request(`/api/jobs/${job.id}/artifact?key=../secrets`)).status, 400);
  await waitFor(() => !jobs.active.size);
  const implementation = { runner: "codex", model: "gpt-5.6-luna", effort: "low" };
  const launched = await request("/api/jobs", { kind: "pr", selection: implementation, specSelection, source: { kind: "issue", value: "#1" } });
  assert.equal(launched.status, 202);
  const pr = await launched.json();
  assert.deepEqual(pr.selection, implementation); assert.deepEqual(pr.specSelection, specSelection);
  await waitFor(() => jobs.get(pr.id).status === "running");
  jobs.stop(pr.id); await waitFor(() => terminalJob(jobs.get(pr.id)) && !jobs.active.size);
  const restored = new Jobs(repo).detail(pr.id);
  assert.deepEqual(restored.specSelection, specSelection); assert.deepEqual(restored.selection, implementation);
  assert.match(jobView(restored), /Spec: Fable 5.1 · max/);
  assert.match(jobView(restored), /Implementation: Codex · GPT-5.6 Luna · low/);
});

test("Codex RPC paginates, routes notifications and approvals, rejects errors and closed connections", async t => {
  const rpc = new CodexRpc({ bin: process.execPath, args: [fileURLToPath(new URL("./helpers/ui-rpc.mjs", import.meta.url))] }); t.after(() => rpc.close());
  await rpc.initialize(); assert.deepEqual((await rpc.list("model/list")).map(row => row.model), ["first", "second"]);
  const notification = once(rpc, "notification"); await rpc.request("fixture/notify"); assert.equal((await notification)[0].method, "item/started");
  const approval = once(rpc, "request"); await rpc.request("fixture/approval"); assert.equal((await approval)[0].id, "request-1");
  await assert.rejects(rpc.request("fixture/error"), /Bearer REDACTED/);
  await assert.rejects(rpc.request("fixture/wait", {}, 25), /timed out/);
  await assert.rejects(rpc.request("fixture/exit"), /disconnected/);
  await assert.rejects(rpc.request("anything"), /closed/);
});

test("Codex approval answers preserve protocol shapes and fail closed on unsupported requests", async () => {
  const ask = async () => ({ allow: true, answers: { name: "An answer" } });
  assert.deepEqual(await answerCodexRequest({ method: "item/commandExecution/requestApproval", params: {} }, ask), { decision: "accept" });
  assert.deepEqual(await answerCodexRequest({ method: "item/fileChange/requestApproval", params: {} }, async () => ({ allow: false })), { decision: "decline" });
  assert.deepEqual(await answerCodexRequest({ method: "item/tool/requestUserInput", params: { questions: [{ id: "name" }] } }, ask), { answers: { name: { answers: ["An answer"] } } });
  await assert.rejects(answerCodexRequest({ method: "future/dangerous", params: {} }, ask), /Unsupported/);
});

test("async scout phases use isolated run files and the configured low-effort read model", async t => {
  const repo = fixture(t), original = process.cwd(); process.chdir(repo); t.after(() => process.chdir(original));
  initConfig(); saveSetup(repo, { ...selection, permissionMode: "yolo", projectId: "123", host: "eu", context, confirmed: true, readModel: "claude-opus-5" });
  writeLocal(repo, candidatesRel("friction"), JSON.stringify({ ids: [{ id: "stale-session" }] }));
  const config = loadConfig(), calls = [], phases = [];
  const probes = { which: () => "/usr/bin/claude", claudeAuth: () => ({ loggedIn: true }), claudeMcpList: () => "posthog: connected" };
  const run = async (runner, prompt, options) => {
    await new Promise(resolve => setTimeout(resolve, 1)); calls.push({ runner, prompt, options });
    writeLocal(repo, ".rusubon/runs/ui-test/close-out.md", "# Friction\nNo qualifying findings.\n");
    if (options.phase === 1) writeLocal(repo, ".rusubon/runs/ui-test/candidates.json", JSON.stringify({ ids: [{ id: "fresh-session", signals: 4 }] }));
    return { status: 0, timedOut: false };
  };
  const result = await runSkill("friction", config, probes, { run, runId: "ui-test", onEvent: event => phases.push(event) });
  assert.equal(result.closeOut, ".rusubon/runs/ui-test/close-out.md"); assert.equal(calls.length, 2);
  assert.equal(calls[0].options.model, "claude-sonnet-5"); assert.equal(calls[1].options.model, "claude-opus-5"); assert.equal(calls[1].options.effort, "low");
  assert.ok(calls.every(call => call.options.permissionMode === "yolo"));
  assert.match(calls[1].prompt, /fresh-session/); assert.doesNotMatch(calls[1].prompt, /stale-session/);
  assert.equal(phases.at(-1).status, "completed");
});

test("failed context drafting restores the human-review placeholder", async t => {
  const repo = fixture(t), original = process.cwd(); process.chdir(repo); t.after(() => process.chdir(original)); initConfig();
  await assert.rejects(draftContext({ run: async (_runner, _prompt, options) => { assert.equal(options.permissionMode, "auto"); writeLocal(repo, ".rusubon/context.md", context); throw new Error("runner disconnected"); } }), /disconnected/);
  assert.equal(workspaceState(repo).confirmed, false);
});
