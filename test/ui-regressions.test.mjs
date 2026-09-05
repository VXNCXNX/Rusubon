import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { trashFixture } from "./helpers/cleanup.mjs";
import { Jobs } from "../src/ui/jobs.mjs";
import { workspaceState, saveSetup, writeLocal } from "../src/ui/workspace.mjs";
import { startDashboard } from "../src/ui/server.mjs";
import { assertContextReady, DRAFT_GUARD } from "../src/context.mjs";
import { collectChecks } from "../src/doctor.mjs";
import { runClaude } from "../src/ui/claude.mjs";
import { createRefreshScheduler } from "../src/ui/web/refresh.js";
import { authorizationUrl, reportView } from "../src/ui/web/views.js";

const selection = { runner: "claude", model: "claude-sonnet-5", effort: "max" };
const context = "# Product\nFixture\n# Money paths\n/checkout\n# Intentional friction\nNone\n# Out of scope\nStaging\n";
const helper = name => fileURLToPath(new URL(`./helpers/${name}.mjs`, import.meta.url));
const input = repo => ({ ...selection, projectId: "123", host: "eu", context, confirmed: false, expectedRevision: workspaceState(repo).revision });
function fixture(t) { const repo = mkdtempSync(join(tmpdir(), "rusubon-regression-")); t.after(() => trashFixture(repo)); return repo; }
async function waitFor(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error("Fixture did not settle"); }

test("findings can be archived without research agents, but not during another operation", () => {
  const report = { slug: "checkout", priority: "P2", path: ".rusubon/inbox/reports/checkout.md", html: "<p>Checkout finding</p>" };
  for (const prReady of [false, true]) for (const busy of [false, true]) {
    const html = reportView(report, selection, { prReady, busy });
    const archive = html.match(/<button[^>]*data-report-archive[^>]*>/)[0];
    const publish = html.match(/<button[^>]*data-report-pr[^>]*>/)[0];
    assert.equal(archive.includes("disabled"), busy);
    assert.equal(publish.includes("disabled"), !prReady || busy);
  }
});

test("authorization links require HTTPS or an explicit loopback host", () => {
  for (const url of ["https://auth.example/authorize", "http://localhost:4242/callback", "http://127.0.0.1:4242/callback", "http://[::1]:4242/callback"]) assert.equal(authorizationUrl(url), url);
  for (const url of ["http://auth.example/authorize", "http://localhost.evil.example/callback", "http://127.0.0.1.evil.example/callback", "https://user:password@auth.example/authorize", "javascript:alert(1)", "data:text/html,login", "//auth.example/authorize", "invalid"]) assert.equal(authorizationUrl(url), null);
});

for (const mode of ["already closed", "closes during send"]) test(`answer API rejects an IPC channel that is ${mode}`, async t => {
  const repo = fixture(t), jobs = new Jobs(repo, { worker: helper("ui-worker") });
  const app = await startDashboard({ repo, jobs, open: false }); t.after(() => app.close());
  const job = jobs.start({ kind: "scout", selection });
  await waitFor(() => job.status === "waiting");
  const child = jobs.active.get(job.id).child;
  if (mode === "already closed") child.disconnect();
  else {
    const send = child.send.bind(child);
    child.send = (message, callback) => {
      if (message.type !== "answer") return send(message, callback);
      queueMicrotask(() => callback(Object.assign(new Error("closed"), { code: "ERR_IPC_CHANNEL_CLOSED" })));
      return false;
    };
  }
  const response = await fetch(`${app.origin}/api/jobs/${job.id}/answer`, { method: "POST", headers: { "Content-Type": "application/json", "X-Rusubon-Token": app.token }, body: JSON.stringify({ requestId: "approval-1", response: { allow: true } }) });
  assert.equal(response.status, 400); assert.match((await response.json()).error, /no longer pending/);
  await waitFor(() => !jobs.active.size);
  assert.deepEqual(job.requests, []);
});

for (const outcome of ["stop", "exit", "complete"]) test(`context drafts stay unconfirmed after ${outcome}`, async t => {
  const repo = fixture(t), jobs = new Jobs(repo, { worker: helper("ui-context-worker") }); t.after(() => jobs.close());
  const job = jobs.start({ kind: "context", selection, about: outcome });
  assert.equal(workspaceState(repo).confirmed, false);
  await waitFor(() => job.eventCount > 0);
  if (outcome === "stop") jobs.stop(job.id);
  await waitFor(() => !jobs.active.size);
  assert.equal(job.status, outcome === "complete" ? "completed" : outcome === "stop" ? "stopped" : "failed");
  assert.equal(workspaceState(repo).confirmed, false);
  assert.match(readFileSync(join(repo, ".rusubon/context.md"), "utf8"), /RUSUBON_CONTEXT_PLACEHOLDER/);
  assert.equal(existsSync(join(repo, DRAFT_GUARD)), false);
  new Jobs(repo);
  const confirmed = saveSetup(repo, { ...input(repo), context: workspaceState(repo).context, confirmed: true });
  assert.equal(confirmed.confirmed, true);
  new Jobs(repo); assert.equal(workspaceState(repo).confirmed, true);
});

test("dashboard death blocks CLI scouting before restart and reseals the interrupted draft on recovery", async t => {
  const repo = fixture(t), original = process.cwd(); process.chdir(repo); t.after(() => process.chdir(original));
  saveSetup(repo, input(repo));
  const parent = spawn(process.execPath, [helper("ui-parent"), "context"], { cwd: repo, stdio: "ignore" });
  t.after(() => { if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL"); });
  await waitFor(() => readFileSync(join(repo, ".rusubon/context.md"), "utf8").includes("Unreviewed agent draft"));
  parent.kill("SIGKILL"); await once(parent, "exit");
  assert.equal(workspaceState(repo).confirmed, false);
  assert.throws(assertContextReady, /recovery/);
  const checks = collectChecks({ runner: "claude", posthog: {projectId:"123",host:"eu"} }, {});
  assert.equal(checks.find(row => row.name === "context").ok, false);
  const app = await startDashboard({ repo, open: false }); t.after(() => app.close());
  assert.equal(app.jobs.list()[0].status, "failed");
  assert.match(workspaceState(repo).context, /RUSUBON_CONTEXT_PLACEHOLDER/);
  assert.equal(workspaceState(repo).confirmed, false);
  assert.equal(existsSync(join(repo, DRAFT_GUARD)), false);
});

test("setup revisions reject external context and configuration edits without writing either file", t => {
  const repo = fixture(t); saveSetup(repo, input(repo));
  for (const path of [".rusubon/context.md", "rusubon.json"]) {
    const stale = input(repo), changed = path.endsWith(".json") ? JSON.stringify({ ...JSON.parse(readFileSync(join(repo, path))), effort: "low" }) : context + "\nHuman correction\n";
    writeLocal(repo, path, changed);
    const before = ["rusubon.json", ".rusubon/context.md"].map(path => readFileSync(join(repo, path), "utf8"));
    assert.throws(() => saveSetup(repo, stale), error => error.statusCode === 409);
    assert.deepEqual(["rusubon.json", ".rusubon/context.md"].map(path => readFileSync(join(repo, path), "utf8")), before);
  }
  assert.throws(() => saveSetup(repo, { ...input(repo), expectedRevision: undefined }), /revision is missing/);
});

test("setup API rejects stale versions before launch and the worker rechecks after queuing", async t => {
  const repo = fixture(t), jobs = new Jobs(repo, { worker: helper("ui-setup-worker") });
  const app = await startDashboard({ repo, jobs, open: false }); t.after(() => app.close());
  const headers = { "X-Rusubon-Token": app.token, "Content-Type": "application/json" };
  const request = setup => fetch(app.origin + "/api/jobs", {method:"POST",headers,body:JSON.stringify({kind:"setup",setup})});
  const stale = input(repo); writeLocal(repo, ".rusubon/context.md", context + "\nExternal edit\n");
  assert.equal((await request(stale)).status, 409); assert.equal(jobs.list().length, 0);
  const response = await request(input(repo)); assert.equal(response.status, 202);
  const job = jobs.get((await response.json()).id); await waitFor(() => job.status === "waiting");
  writeLocal(repo, ".rusubon/context.md", context + "\nEdited while queued\n");
  await jobs.answer(job.id, "save", {allow:true}); await waitFor(() => !jobs.active.size);
  assert.equal(job.status, "failed"); assert.match(job.error, /changed on disk/);
  assert.match(workspaceState(repo).context, /Edited while queued/); assert.equal(existsSync(join(repo,"rusubon.json")), false);
});

test("first-time setup checks the original revision before initialization creates files", async t => {
  const repo = fixture(t), app = await startDashboard({repo,open:false}); t.after(() => app.close());
  const job = app.jobs.start({kind:"setup",setup:input(repo)});
  await waitFor(() => !app.jobs.active.size);
  assert.equal(job.status, "completed"); assert.ok(existsSync(join(repo,"rusubon.json"))); assert.equal(workspaceState(repo).confirmed,false);
});

test("Claude adapter rejects drift even when the stream later reports success", async () => {
  const init = {type:"system",subtype:"init",model:selection.model,effort:selection.effort,session_id:"fixture"};
  const success = {type:"result",subtype:"success",is_error:false};
  for (const scenario of ["effort", "fallback", "hook", "switch", "missing"]) {
    let closed = false, opts;
    const createQuery = ({options}) => {
      opts = options;
      const stream = (async function* () {
        yield scenario === "effort" ? {...init,effort:"low"} : scenario === "missing" ? {...init,effort:undefined} : init;
        if (scenario === "fallback") yield {type:"system",subtype:"model_refusal_fallback",fallback_model:"claude-fable-5-1"};
        if (scenario === "hook") await options.hooks.Stop[0].hooks[0]({hook_event_name:"Stop",effort:{level:"low"}});
        if (scenario === "switch") await options.hooks.PreModelSwitch[0].hooks[0]({hook_event_name:"PreModelSwitch",to_model:"claude-opus-5"});
        yield success;
      })(); stream.close = () => {closed=true;}; return stream;
    };
    await assert.rejects(runClaude("fixture", { ...selection, cwd:"/tmp", emit:()=>{}, ask:async()=>({allow:false}), createQuery }), /effort|fell back|switch/);
    assert.equal(closed,true); assert.deepEqual(opts.settings.fallbackModel,[]); assert.deepEqual(opts.settings.availableModels,[selection.model]);
    assert.equal(opts.env.CLAUDE_CODE_EFFORT_LEVEL, "max");
  }
});

test("Claude verifies effective effort from a Stop hook when init omits it", async () => {
  const events = [];
  const createQuery = ({options}) => {
    const stream = (async function* () {
      yield {type:"system",subtype:"init",model:selection.model,session_id:"fixture"};
      await options.hooks.Stop[0].hooks[0]({hook_event_name:"Stop",effort:{level:"max"}});
      yield {type:"result",subtype:"success",is_error:false};
    })(); stream.close=()=>{}; return stream;
  };
  assert.equal((await runClaude("fixture",{...selection,cwd:"/tmp",emit:e=>events.push(e),ask:async()=>({allow:false}),createQuery})).status,0);
  assert.equal(events.filter(e=>e.type==="selection_verified").length,1);
});

test("continuous events cannot starve refresh, and refresh failures remain observable", async t => {
  t.mock.timers.enable({apis:["setTimeout"]});
  let refreshes = 0; const errors = [];
  const schedule = createRefreshScheduler(() => {refreshes++;if(refreshes===2)throw new Error("transient failure");},e=>errors.push(e));
  for(let i=0;i<30;i++){schedule();t.mock.timers.tick(100);await Promise.resolve();await Promise.resolve();}
  assert.ok(refreshes >= 10, `Only ${refreshes} refreshes during continuous events`);
  assert.equal(errors.length,1); assert.match(errors[0].message,/transient/);
});
