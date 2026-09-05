import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { trashFixture } from "./helpers/cleanup.mjs";
import { DEFAULT_SCOUT, moneyPaths, pathMatches, resolveScoutScope, scoutOptions, scoutWindow, windowLabel } from "../src/scout-scope.mjs";
import { scopedQueries } from "../src/scout-queries.mjs";
import { scopedCandidates } from "../src/candidates.mjs";
import { runSkill } from "../src/run.mjs";
import { initConfig, loadConfig } from "../src/config.mjs";
import { assertSetupRevision, saveSetup, workspaceState, writeLocal } from "../src/ui/workspace.mjs";
import { startDashboard } from "../src/ui/server.mjs";
import { Jobs, terminalJob } from "../src/ui/jobs.mjs";
import { scopeView } from "../src/ui/web/views.js";

const now = new Date("2026-09-05T23:59:59.000Z");
const context = "# Product\nAnalytics at https://product.example.\n\n# Money paths\n- /checkout\n- https://app.example/signup\n- /workspace/:id/billing\n\n# Intentional friction\nConfirm paid changes at /confirm.\n\n# Out of scope\n/admin\n";
const workspace = { confirmed: true, context, config: { posthog: { projectId: "123", host: "eu" } } };
const selection = { runner: "claude", model: "claude-sonnet-5", effort: "high" };
const opts = { ...DEFAULT_SCOUT, checks: ["clicks"], focus: ["/checkout"], note: "Address validation changed." };
const scope = () => ({ ...resolveScoutScope(opts, workspace, now), id: "scope-test" });
const candidate = (s = scope()) => ({ sessionId: "session-1", signals: 4, paths: ["/checkout/address"], lastSignalAt: s.window.start, signalTypes: ["$rageclick"] });
function fixture(t) { const repo = mkdtempSync(join(tmpdir(), "rusubon-scope-")); t.after(() => trashFixture(repo)); return repo; }
function setup(repo, scout) { return saveSetup(repo, { ...selection, projectId: "123", host: "eu", context, confirmed: true, ...(scout ? { scout } : {}), expectedRevision: workspaceState(repo).revision }); }
async function waitFor(predicate) { const deadline = Date.now() + 8000; while (!predicate()) { if (Date.now() > deadline) throw new Error("Timed out waiting for fixture"); await new Promise(resolve => setTimeout(resolve, 20)); } }

test("relative periods use complete UTC days and equal previous periods", () => {
  for (const days of [7, 14, 30]) {
    const w = scoutWindow({ period: `${days}d` }, now);
    assert.equal(w.end, "2026-09-05T00:00:00.000Z"); assert.equal(w.days, days);
    assert.equal(Date.parse(w.end) - Date.parse(w.start), days * 86_400_000);
    assert.equal(Date.parse(w.start) - Date.parse(w.baselineStart), days * 86_400_000);
    assert.equal(Date.parse(w.end) - Date.parse(w.historyStart), Math.max(30, days * 2) * 86_400_000);
  }
  assert.equal(windowLabel(scoutWindow(opts, now)), "2026-08-29 to 2026-09-04 · UTC");
  assert.equal(scoutWindow(opts, "2026-09-06T00:01Z").start, "2026-08-30T00:00:00.000Z");
});

test("custom dates include their last day and reject invalid, future, reversed and oversized ranges", () => {
  const custom = (startDate, endDate) => ({ period: "custom", startDate, endDate });
  const leap = scoutWindow(custom("2024-02-29", "2024-02-29"), now);
  assert.equal(leap.days, 1); assert.equal(leap.end, "2024-03-01T00:00:00.000Z");
  for (const input of [custom("2026-02-29", "2026-03-01"), custom("2026-09-04", "2026-09-05"), custom("2026-09-03", "2026-09-02"), custom("2026-01-01", "2026-09-01"), custom("", "2026-09-01")]) assert.throws(() => scoutWindow(input, now));
  assert.deepEqual(scoutWindow(custom("2024-02-29", "2024-02-29"), "2027-01-01"), leap);
});

test("focus derives only from confirmed money paths, with host and segment boundaries", () => {
  assert.deepEqual(moneyPaths(context), ["/checkout", "https://app.example/signup", "/workspace/:id/billing"]);
  assert.deepEqual(moneyPaths("# Money paths\nSignup / billing at /checkout"), ["/checkout"]);
  assert.deepEqual(moneyPaths("# Money paths\n- /\n"), ["/"]);
  assert.deepEqual(moneyPaths("# Money paths\n`/checkout?x=1`, [sign up](https://app.example/signup).\n## Upgrade\n/workspace/*/billing\n# Out of scope\n/private"), ["/checkout", "https://app.example/signup", "/workspace/*/billing"]);
  assert.ok(pathMatches("/checkout/address?test=1", ["/checkout"]));
  assert.ok(!pathMatches("/checkout-old", ["/checkout"]));
  assert.ok(pathMatches("https://app.example/signup/start", ["https://app.example/signup"]));
  assert.ok(!pathMatches("https://evil.example/signup", ["https://app.example/signup"]));
  assert.ok(!pathMatches("/signup", ["https://app.example/signup"]));
  assert.ok(pathMatches("/workspace/123/billing", ["/workspace/:id/billing"]));
  assert.ok(!pathMatches("/workspace/123/nested/billing", ["/workspace/:id/billing"]));
  assert.ok(pathMatches("/workspace/123/nested/billing", ["/workspace/*/billing"]));
  assert.ok(pathMatches("/anything", ["/"]));
  for (const w of [{ ...workspace, confirmed: false }, { ...workspace, context: "# Money paths\nSign up" }, { ...workspace, config: { posthog: { projectId: "bad", host: "eu" } } }]) assert.throws(() => resolveScoutScope(opts, w, now));
  assert.throws(() => resolveScoutScope({ ...opts, focus: ["/admin"] }, workspace, now), /no longer/);
  assert.equal(resolveScoutScope(opts, { ...workspace, config: { posthog: { projectId: 123, host: "https://eu.posthog.com" } } }, now).source.region, "eu");
});

test("scope validation requires a supported check, path selection, and bounded context", () => {
  for (const patch of [{ checks: [] }, { checks: ["arbitrary-sql"] }, { focus: [] }, { period: "all" }, { note: "x".repeat(2001) }]) assert.throws(() => scoutOptions({ ...opts, ...patch }));
  assert.deepEqual(scoutOptions({ ...opts, checks: ["clicks", "clicks"] }).checks, ["clicks"]);
});

test("selected checks produce only their bounded SQL with numeric UTC timestamps and path predicates", () => {
  const expected = { clicks: ["traffic", "clicks", "candidates"], errors: ["traffic", "exceptions", "broken-sessions", "candidates", "feature-candidates"], coverage: ["traffic", "capture-presence", "capture-ratio"], replay: ["traffic", "replay-signals", "replay-candidates"] };
  for (const [check, ids] of Object.entries(expected)) {
    const s = { ...scope(), options: { ...opts, checks: [check] } }, rows = scopedQueries(s);
    assert.deepEqual(rows.map(row => row.id), ids);
    for (const { sql } of rows) {
      assert.doesNotMatch(sql, /now\(|INTERVAL|today\(/);
      assert.ok(sql.includes(`toDateTime(${Date.parse(s.window.end) / 1000})`));
      assert.match(sql, /checkout/);
    }
    const sql = rows.map(row => row.sql).join("\n");
    if (check !== "replay") assert.doesNotMatch(sql, /\$recording_observed|scanner_id/);
    if (check !== "coverage") assert.doesNotMatch(sql, /raw_session_replay_events/);
    if (check !== "errors") assert.doesNotMatch(sql, /\$exception|session_replay_features/);
    if (check !== "clicks") assert.doesNotMatch(sql, /\$rageclick|\$dead_click/);
  }
  const s = resolveScoutScope({ ...opts, focus: ["https://app.example/signup"] }, workspace, now);
  assert.match(scopedQueries(s)[0].sql, /properties\.\$host = 'app.example'/);
  const replay = scopedQueries({ ...scope(), options: { ...opts, checks: ["replay"] } }).at(-1).sql;
  assert.match(replay, /toString\(properties.session_id\)/); assert.match(replay, /INNER JOIN/);
  assert.equal((replay.match(/GROUP BY session_id/g) || []).length, 2);
});

test("session handoff rejects unrelated, stale, unbounded and disabled-check candidates", () => {
  const s = scope(), good = candidate(s), parse = rows => scopedCandidates({ scopeId: s.id, ids: rows }, s);
  assert.deepEqual(parse([good, { ...good, sessionId: "other", signals: 9 }, good]).ids.map(row => row.sessionId), ["other", "session-1"]);
  for (const patch of [{ lastSignalAt: s.window.end }, { lastSignalAt: s.window.baselineStart }, { lastSignalAt: "2026-09-01T10:00:00" }, { paths: ["/admin"] }, { signalTypes: ["$exception"] }, { signals: 0 }, { sessionId: "" }, { sessionId: "session') OR 1=1" }]) assert.throws(() => parse([{ ...good, ...patch }]), /outside/);
  assert.throws(() => parse([null]), /invalid/);
  assert.throws(() => scopedCandidates({ scopeId: "different", ids: [] }, s), /scope/);
  assert.throws(() => scopedCandidates({ scopeId: s.id, ids: [good] }, { ...s, options: { ...opts, checks: ["coverage"] } }), /outside/);
});

test("signal queries aggregate normalized surfaces while scope and candidates retain raw paths", () => {
  const s = resolveScoutScope({ ...opts, focus: ["/workspace/:id/billing"], checks: ["clicks", "errors"] }, workspace, now);
  const queries = scopedQueries(s);
  for (const id of ["clicks", "exceptions"]) {
    const sql = queries.find(row => row.id === id).sql;
    const projection = sql.slice(0, sql.indexOf(" AS path"));
    assert.match(projection, /replaceRegexpAll\(replaceRegexpAll\(cutQueryStringAndFragment\(properties\.\$pathname\)/);
    assert.ok(projection.includes("'[0-9a-fA-F-]{8,}', ':id'"));
    assert.ok(projection.includes("'[0-9]+', ':id'"));
    assert.match(sql, /GROUP BY host, path/);
    assert.match(sql, /match\(cutQueryStringAndFragment\(properties\.\$pathname\), '\^\/workspace\/\[\^\/\]\+\/billing/);
  }
  const candidates = queries.find(row => row.id === "candidates").sql;
  assert.match(candidates, /groupUniqArray\(coalesce\(properties\.\$current_url, properties\.\$pathname\)\) AS paths/);
  assert.doesNotMatch(candidates, /replaceRegexpAll/);
  const path = "/workspace/123/billing";
  assert.equal(scopedCandidates({ scopeId: "scope-test", ids: [{ ...candidate(), paths: [path] }] }, { ...s, id: "scope-test" }).ids[0].paths[0], path);
});

test("saved scope survives config reload and both phases keep the frozen source, context, dates and candidates", async t => {
  const repo = fixture(t), original = process.cwd(); process.chdir(repo); t.after(() => process.chdir(original));
  initConfig(); setup(repo, opts);
  assert.deepEqual(loadConfig().scout, opts); assert.deepEqual(workspaceState(repo).config.scout, opts);
  const config = loadConfig(), calls = [], events = [];
  const probes = { which: () => "/usr/bin/claude", claudeAuth: () => ({ loggedIn: true }), claudeMcpList: () => "posthog: connected" };
  const run = async (_runner, prompt, options) => {
    calls.push({ prompt, options });
    const saved = JSON.parse(readFileSync(join(repo, ".rusubon/runs/ui-scope/scout-scope.json"), "utf8"));
    writeLocal(repo, ".rusubon/runs/ui-scope/close-out.md", "# Friction\nNo qualifying findings.\n");
    if (options.phase === 1) {
      writeLocal(repo, ".rusubon/runs/ui-scope/candidates.json", JSON.stringify({ scopeId: saved.id, ids: [candidate(saved)] }));
      writeLocal(repo, ".rusubon/context.md", context.replace("Address", "Changed").replace("Analytics at", "Different product at"));
    }
    return { status: 0 };
  };
  await runSkill("friction", config, probes, { run, runId: "ui-scope", onEvent: event => events.push(event) });
  assert.equal(calls.length, 2); assert.equal(calls[1].options.effort, "low");
  const saved = events.find(event => event.type === "scope").scope;
  assert.match(saved.id, /^[a-f0-9]{64}$/);
  for (const call of calls) { assert.ok(call.prompt.includes(saved.id)); assert.ok(call.prompt.includes(saved.window.start)); assert.ok(call.prompt.includes(JSON.stringify(context))); assert.doesNotMatch(call.prompt, /Different product/); }
  assert.match(calls[1].prompt, /session-1/);
  assert.match(scopeView(saved), /PostHog · Project 123 · EU/);
  assert.match(scopeView({ ...saved, options: { ...opts, note: "<script>bad</script>" } }), /&lt;script&gt;/);
});

test("invalid scoped candidates fail before phase 2; missing PostHog tools can close out without candidates", async t => {
  const repo = fixture(t), original = process.cwd(); process.chdir(repo); t.after(() => process.chdir(original));
  initConfig(); setup(repo);
  const probes = { which: () => "/usr/bin/claude", claudeAuth: () => ({ loggedIn: true }), claudeMcpList: () => "posthog: connected" };
  let calls = 0;
  await assert.rejects(runSkill("friction", loadConfig(), probes, { scope: scope(), runId: "ui-reject", run: async () => {
    calls++; writeLocal(repo, ".rusubon/runs/ui-reject/close-out.md", "No qualifying findings");
    writeLocal(repo, ".rusubon/runs/ui-reject/candidates.json", JSON.stringify({ scopeId: "old", ids: [] })); return { status: 0 };
  } }), /scope/);
  assert.equal(calls, 1);
  await runSkill("friction", loadConfig(), probes, { scope: scope(), runId: "ui-no-tools", run: async () => {
    calls++; writeLocal(repo, ".rusubon/runs/ui-no-tools/close-out.md", "No PostHog tools. No evidence queried."); return { status: 0 };
  } });
  assert.equal(calls, 2);
});

test("HTTP validates explicit scope and setup revision, serves browser modules, and persists the resolved job snapshot", async t => {
  const repo = fixture(t); setup(repo);
  const jobs = new Jobs(repo, { worker: fileURLToPath(new URL("./helpers/ui-worker.mjs", import.meta.url)) });
  const app = await startDashboard({ repo, jobs, open: false }); t.after(() => app.close());
  const request = data => fetch(app.origin + "/api/jobs", { method: "POST", headers: { "X-Rusubon-Token": app.token, "Content-Type": "application/json" }, body: JSON.stringify({ kind: "scout", selection, expectedRevision: workspaceState(repo).revision, ...data }) });
  for (const path of ["/scope.js", "/scout-scope.mjs", "/scope-controls.js"]) { const r = await fetch(app.origin + path); assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /javascript/); await r.text(); }
  for (const scout of [{ ...opts, checks: [] }, { ...opts, focus: ["/admin"] }, { ...opts, note: "phc_sensitiveValue" }, { ...opts, period: "custom", startDate: "2099-01-01", endDate: "2099-01-02" }]) assert.equal((await request({ scout })).status, 400);
  const oldRevision = workspaceState(repo).revision;
  writeLocal(repo, ".rusubon/context.md", context + "\nChanged exclusions.\n");
  assert.throws(() => assertSetupRevision(repo, oldRevision), /changed/);
  assert.equal((await request({ scout: opts, expectedRevision: oldRevision })).status, 409);
  const response = await request({ scout: opts }); assert.equal(response.status, 202); const launched = await response.json();
  assert.deepEqual(launched.scoutScope.options, opts); assert.equal(launched.scoutScope.source.projectId, "123");
  assert.deepEqual(launched.scoutScope.paths, ["/checkout"]);
  await waitFor(() => jobs.get(launched.id).status === "waiting"); jobs.answer(launched.id, "approval-1", { allow: true });
  await waitFor(() => terminalJob(jobs.get(launched.id)) && !jobs.active.size);
  assert.deepEqual(new Jobs(repo).detail(launched.id).scoutScope, launched.scoutScope);
  const actualJobs = new Jobs(repo); t.after(() => actualJobs.close());
  const stale = actualJobs.start({ kind: "scout", selection, scoutScope: { ...launched.scoutScope, revision: oldRevision } });
  await waitFor(() => terminalJob(stale) && !actualJobs.active.size);
  assert.equal(stale.status, "failed"); assert.match(stale.error, /changed on disk/);
  assert.ok(!actualJobs.detail(stale.id).events.some(event => event.type === "model"));
});

test("repeated scoped CLI runs isolate artifacts and cannot reuse a previous candidate file", async t => {
  const repo = fixture(t), original = process.cwd(); process.chdir(repo); t.after(() => process.chdir(original));
  initConfig(); setup(repo, opts);
  const probes = { which: () => "/usr/bin/claude", claudeAuth: () => ({ loggedIn: true }), claudeMcpList: () => "posthog: connected" };
  const paths = [];
  for (const omitCandidates of [false, true]) {
    const operation = runSkill("friction", loadConfig(), probes, { run: async (_runner, prompt) => {
      const close = prompt.match(/Close out at (\.rusubon\/runs\/scout-[^,]+),/)[1];
      paths.push(close); writeLocal(repo, close, "No qualifying findings.");
      if (!omitCandidates) {
        const s = JSON.parse(readFileSync(join(repo, close.replace("close-out.md", "scout-scope.json")), "utf8"));
        writeLocal(repo, close.replace("close-out.md", "candidates.json"), JSON.stringify({ scopeId: s.id, ids: [] }));
      }
      return { status: 0 };
    } });
    if (omitCandidates) await assert.rejects(operation, /did not write scoped candidates/); else await operation;
  }
  assert.notEqual(paths[0], paths[1]);
});
