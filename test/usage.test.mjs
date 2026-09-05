import assert from "node:assert/strict";
import { test } from "node:test";
import fs, { mkdtempSync, appendFileSync, symlinkSync, readFileSync, existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trashFixture } from "./helpers/cleanup.mjs";
import { aggregateUsage, codexTokens, createUsageReader, usageCollector } from "../src/ui/usage.mjs";
import { estimateCost, MODEL_RATES, pricingState, saveUsageRate } from "../src/ui/usage-pricing.mjs";
import { writeLocal } from "../src/ui/workspace.mjs";
import { startDashboard } from "../src/ui/server.mjs";
import { Jobs } from "../src/ui/jobs.mjs";
import { runClaude } from "../src/ui/claude.mjs";

const selection = { runner: "codex", model: "gpt-6-astra", effort: "high" };
const at = "2026-09-05T12:00:00Z";
const job = { id: "ui-abcd", kind: "scout", selection, status: "completed", startedAt: at, finishedAt: at };
const pricing = { rates: MODEL_RATES };
const snapshot = (inputTokens, cachedInputTokens, outputTokens, cacheWriteInputTokens = 0) => ({ inputTokens, cachedInputTokens, outputTokens, cacheWriteInputTokens });
const event = (total, extra = {}) => ({ type: "usage", at, usage: { total, last: total }, ...extra });
const fixture = t => { const repo = mkdtempSync(join(tmpdir(), "rusubon-usage-")); t.after(() => trashFixture(repo)); return repo; };
const aggregate = (histories, options = {}) => aggregateUsage(histories, { pricing, now: new Date(at), ...options });
const git = (repo, ...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });

test("init ignores repository-local usage rates and their atomic temporary files", t => {
  const repo = fixture(t);
  assert.equal(git(repo, "init", "-q").status, 0);
  const init = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/rusubon.mjs", import.meta.url)), "init"], { cwd: repo, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  for (const path of [".rusubon/usage-rates.json", ".rusubon/usage-rates.json.123.tmp"])
    assert.equal(git(repo, "check-ignore", "--no-index", path).status, 0, `${path} must stay local`);
});

test("saving rates upgrades old ignore rules once and preserves existing content", t => {
  const repo = fixture(t), original = "# Product rules\r\nnode_modules/\r\n.rusubon/inbox/\r\n.rusubon/runs/";
  assert.equal(git(repo, "init", "-q").status, 0);
  writeLocal(repo, ".gitignore", original);
  const save = () => saveUsageRate(repo, { ...MODEL_RATES.at(-1), input: 8, revision: pricingState(repo).revision });
  save();
  assert.equal(git(repo, "check-ignore", "--no-index", ".rusubon/usage-rates.json").status, 0);
  const updated = readFileSync(join(repo, ".gitignore"), "utf8");
  assert.ok(updated.startsWith(original));
  save();
  assert.equal(readFileSync(join(repo, ".gitignore"), "utf8"), updated);
  assert.doesNotMatch(git(repo, "status", "--porcelain", "--untracked-files=all").stdout, /usage-rates/);
});

test("saving rates refuses a linked gitignore before writing local data", t => {
  const repo = fixture(t), outside = fixture(t);
  writeLocal(outside, ".gitignore", "# External rules\n");
  symlinkSync(join(outside, ".gitignore"), join(repo, ".gitignore"));
  assert.throws(() => saveUsageRate(repo, { ...MODEL_RATES.at(-1), revision: pricingState(repo).revision }), /symbolic link/);
  assert.equal(readFileSync(join(outside, ".gitignore"), "utf8"), "# External rules\n");
  assert.equal(existsSync(join(repo, ".rusubon/usage-rates.json")), false);
});

test("reader opens only relevant histories and preserves boundary deltas and mixed-runner PRs", async t => {
  const repo = fixture(t), opened = [], original = fs.createReadStream;
  t.mock.method(fs, "createReadStream", (path, options) => { opened.push(path); return original(path, options); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const jobs = [
    { ...job, id: "ui-01", startedAt: "2026-08-01", finishedAt: "2026-08-02" },
    { ...job, id: "ui-02", selection: { runner: "claude" } },
    { ...job, id: "ui-03", startedAt: "2026-09-06", finishedAt: "2026-09-06" },
    { ...job, id: "ui-04", startedAt: "2026-08-29T23:58:00Z", finishedAt: "2026-08-30T00:00:00Z" },
    { ...job, id: "ui-05", kind: "pr", selection: { runner: "claude" }, specSelection: selection },
    { ...job, id: "ui-06", startedAt: "2026-08-01", finishedAt: undefined, status: "running" },
    { ...job, id: "ui-07", selection: undefined },
    { ...job, id: "ui-08", kind: "pr", selection: { runner: "claude" } },
  ];
  for (const row of jobs) {
    const events = row.id === "ui-04" ? [event(snapshot(100, 50, 10), { at: row.startedAt }), event(snapshot(300, 150, 30), { at: row.finishedAt })]
      : [event(snapshot(100, 0, 10), { at: row.finishedAt || at, runner: row.id === "ui-02" ? "claude" : "codex", model: selection.model })];
    writeLocal(repo, `.rusubon/runs/${row.id}/events.jsonl`, events.map(e => JSON.stringify(e)).join("\n") + "\n");
  }
  const read = createUsageReader(repo);
  const result = await read(jobs, { days: 7, runner: "codex", now: new Date(at) });
  assert.deepEqual(opened.map(path => path.split("/").at(-2)), ["ui-04", "ui-05", "ui-06", "ui-07", "ui-08"]);
  assert.equal(result.total.tokens.total, 660);
  assert.equal(result.daily[0].tokens.total, 220, "keep the pre-window baseline for cumulative counters");
  assert.equal(result.total.runs, 5);
  opened.length = 0;
  await assert.rejects(read(jobs, { days: -1 }), /Choose/);
  assert.equal(opened.length, 0, "reject invalid filters before touching histories");
  await read(jobs, { days: 90, runner: "codex", now: new Date(at) });
  assert.deepEqual(opened.map(path => path.split("/").at(-2)), ["ui-01"], "expanded windows load previously skipped history and reuse matching cache entries");
});

test("Codex cache reads/writes partition input and reasoning is not counted again", () => {
  assert.deepEqual(codexTokens({ ...snapshot(100, 80, 20, 40), reasoningOutputTokens: 15 }), { input: 0, cacheRead: 80, cacheWrite: 20, output: 20, total: 120 });
});

test("cumulative updates, duplicate notifications and phases count once", () => {
  const c = usageCollector(job);
  c.push({ type: "session", ...selection, sessionId: "one", at });
  c.push(event(snapshot(100, 60, 10)));
  c.push(event(snapshot(200, 150, 30), { usage: { total: snapshot(200, 150, 30), last: snapshot(100, 90, 20) } }));
  c.push(event(snapshot(200, 150, 30)));
  c.push({ type: "session", ...selection, sessionId: "two", at });
  c.push(event(snapshot(100, 60, 10)));
  const result = aggregate([{ job, ...c.result() }]);
  assert.equal(result.total.tokens.total, 340);
  assert.equal(result.total.tokens.input, 90);
  assert.equal(result.total.tokens.cacheRead, 210);
  assert.equal(result.total.runs, 1);
  assert.equal(result.partialRuns, 0);
});

test("Codex deltas use their UTC day while counting the same run once", () => {
  const c = usageCollector(job);
  c.push(event(snapshot(100, 0, 10), { at: "2026-09-04T23:59:00Z" }));
  c.push(event(snapshot(300, 0, 40)));
  const result = aggregate([{ job, ...c.result() }]);
  assert.equal(result.daily.at(-2).tokens.total, 110);
  assert.equal(result.daily.at(-1).tokens.total, 230);
  assert.equal(result.total.runs, 1);
});

test("Claude cumulative modelUsage includes delegated models without adding main usage again", () => {
  const c = usageCollector({ ...job, selection: { runner: "claude", model: "claude-fable-5-1" } });
  const raw = { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 1000, cacheCreationInputTokens: 200, costUSD: 0.125, costBasis: "list" };
  const e = { type: "usage", at, sessionId: "claude-1", usage: { input_tokens: 9000, output_tokens: 9000 }, modelUsage: { "claude-fable-5-1": raw, "claude-sonnet-5": { ...raw, costUSD: 0.025 } } };
  c.push(e); c.push(e);
  const result = aggregate([{ job, ...c.result() }]);
  assert.equal(result.total.tokens.total, 2700);
  assert.equal(result.models.length, 2);
  assert.equal(result.total.cost, 0.15);
  assert.deepEqual(result.total.bases, ["runner"]);
});

test("Fable 5.1 uses its exact read rate, and cache TTL is never silently guessed", () => {
  const record = { runner: "claude", model: "claude-fable-5-1", tokens: { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 2e6 }, write5m: 1e6, write1h: 1e6 };
  assert.equal(estimateCost(record, MODEL_RATES).cost, 92.75);
  assert.equal(estimateCost({ ...record, write5m: null, write1h: null }, MODEL_RATES).cost, null);
  assert.equal(estimateCost({ ...record, model: "claude-fable-5" }, MODEL_RATES).cost, 93.5);
});

test("Astra charges cache writes and applies long-context rates to the full request", () => {
  const record = { runner: "codex", model: "gpt-6-astra", singleRequest: true, tokens: { input: 100_000, cacheRead: 150_000, cacheWrite: 50_000, output: 1000 } };
  assert.equal(estimateCost(record, MODEL_RATES).cost, 3.625);
  assert.equal(estimateCost({ ...record, singleRequest: false }, MODEL_RATES).cost, null);
  assert.equal(estimateCost({ ...record, tokens: { input: 100, cacheRead: 100, cacheWrite: 100, output: 10 } }, MODEL_RATES).cost, 0.00285);
});

test("unknown models and guessed provider costs remain unavailable", () => {
  const c = usageCollector({ ...job, selection: { runner: "claude", model: "private-model" } });
  c.push({ type: "usage", at, modelUsage: { "private-model": { inputTokens: 100, outputTokens: 100, costUSD: 1, costBasis: "unknown" } } });
  const result = aggregate([{ job, ...c.result() }]);
  assert.equal(result.total.cost, null);
  assert.equal(result.total.unpricedTokens, 200);
  assert.equal(result.models[0].key, "private-model");
});

test("legacy Claude coverage and phases stopped before usage are marked incomplete", () => {
  const c = usageCollector({ ...job, selection: { runner: "claude", model: "claude-sonnet-5" } });
  c.push({ type: "usage", at, usage: { input_tokens: 100, output_tokens: 10 } });
  c.push({ type: "session", runner: "claude", sessionId: "stopped-phase", at });
  const result = aggregate([{ job, ...c.result() }, { job: { ...job, id: "ui-beef" }, records: [] }]);
  assert.equal(result.partialRuns, 1);
  assert.equal(result.missingRuns, 1);
});

test("filters exclude old runs and other runners, with zero-filled daily series", () => {
  const c = usageCollector(job); c.push(event(snapshot(100, 0, 10)));
  const history = { job, ...c.result() };
  assert.equal(aggregate([history], { runner: "claude", days: 7 }).total.runs, 0);
  assert.equal(aggregate([history], { runner: "claude", days: 7 }).missingRuns, 0);
  assert.equal(aggregate([history], { days: 7 }).daily.length, 7);
  assert.equal(aggregate([history], { now: new Date("2026-10-20"), days: 7 }).total.runs, 0);
  assert.throws(() => aggregate([history], { days: 999 }), /Choose/);
});

test("usage reader scans beyond the last 600 events, refreshes appended counters and never returns transcript text", async t => {
  const repo = fixture(t), path = `.rusubon/runs/${job.id}/events.jsonl`;
  writeLocal(repo, path, [event(snapshot(100, 50, 10)), ...Array.from({ length: 610 }, () => ({ type: "message", text: "PRIVATE TRANSCRIPT" }))].map(e => JSON.stringify(e)).join("\n") + "\n");
  const read = createUsageReader(repo);
  const first = await read([job], { now: new Date(at) });
  assert.equal(first.total.tokens.total, 110);
  assert.ok(!JSON.stringify(first).includes("PRIVATE TRANSCRIPT"));
  appendFileSync(join(repo, path), JSON.stringify(event(snapshot(200, 150, 30))) + "\n{broken\n");
  const next = await read([job], { now: new Date(at) });
  assert.equal(next.total.tokens.total, 230);
  assert.equal(next.partialRuns, 1);
});

test("rates are local, validated, revision-protected, and resettable", t => {
  const repo = fixture(t), original = pricingState(repo);
  const rate = { ...MODEL_RATES.at(-1), input: 8, revision: original.revision };
  const saved = saveUsageRate(repo, rate);
  assert.equal(saved.rates.at(-1).input, 8);
  assert.equal(saved.rates.at(-1).longContext, 272000);
  assert.throws(() => saveUsageRate(repo, rate), /changed/);
  assert.throws(() => saveUsageRate(repo, { ...rate, revision: saved.revision, input: -1 }), /Rates/);
  const reset = saveUsageRate(repo, { ...rate, revision: saved.revision, reset: true });
  assert.equal(reset.rates.at(-1).input, 10);
  assert.equal(reset.rates.at(-1).custom, undefined);
});

test("usage API requires authentication and rejects linked history", async t => {
  const repo = fixture(t), outside = fixture(t);
  writeLocal(outside, "events.jsonl", JSON.stringify(event(snapshot(100, 0, 20))));
  writeLocal(repo, `.rusubon/runs/${job.id}/job.json`, JSON.stringify(job));
  symlinkSync(join(outside, "events.jsonl"), join(repo, `.rusubon/runs/${job.id}/events.jsonl`));
  const app = await startDashboard({ repo, open: false, jobs: new Jobs(repo) });
  t.after(() => app.close());
  assert.equal((await fetch(`${app.origin}/api/usage`)).status, 401);
  const response = await fetch(`${app.origin}/api/usage`, { headers: { "X-Rusubon-Token": app.token } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).total.tokens.total, 0);
  assert.equal((await fetch(`${app.origin}/api/usage?days=-1`, { headers: { "X-Rusubon-Token": app.token } })).status, 400);
  const rate = { ...MODEL_RATES.at(-1), input: 20, revision: pricingState(repo).revision };
  const save = () => fetch(`${app.origin}/api/usage/rates`, { method: "POST", headers: { "X-Rusubon-Token": app.token, "Content-Type": "application/json" }, body: JSON.stringify(rate) });
  assert.equal((await save()).status, 200);
  assert.equal((await save()).status, 409);
  assert.equal(pricingState(repo).rates.at(-1).input, 20);
});

test("Claude adapter persists per-model cost and counters in the usage event", async () => {
  const events = [], modelUsage = { "claude-sonnet-5": { inputTokens: 100, outputTokens: 20, costUSD: 0.1 } };
  const createQuery = () => {
    const stream = (async function* () {
      yield { type: "system", subtype: "init", model: "claude-sonnet-5", effort: "high", session_id: "usage-session" };
      yield { type: "result", subtype: "success", is_error: false, session_id: "usage-session", modelUsage, total_cost_usd: 0.1 };
    })(); stream.close = () => {}; return stream;
  };
  await runClaude("fixture", { cwd: "/tmp", model: "claude-sonnet-5", effort: "high", emit: e => events.push(e), ask: async () => ({ allow: false }), createQuery });
  const usage = events.find(e => e.type === "usage");
  assert.deepEqual(usage.modelUsage, modelUsage);
  assert.equal(usage.sessionId, "usage-session");
  assert.equal(usage.totalCostUsd, 0.1);
});
