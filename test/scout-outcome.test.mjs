import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { jobView, runList, readiness } from "../src/ui/web/views.js";

const selection = { runner: "codex", model: "gpt-5.6-luna", effort: "high" };
const job = {
  id: "ui-fixture", kind: "scout", status: "completed", selection,
  startedAt: "2026-09-05T17:19:58Z", finishedAt: "2026-09-05T17:26:57Z",
  events: [{ type: "phase", name: "SQL analysis", status: "completed" }],
  result: { reports: [], memory: [], mcp: "ok", closeLine: "- Run ID: ui-fixture", closeOut: ".rusubon/runs/ui-fixture/close-out.md" },
  artifacts: [{ key: "Run/close-out.md", label: "Run / close-out.md" }],
};

test("a completed empty scout explains its outcome before progress, including saved older runs", () => {
  const html = jobView(job);
  assert.match(html, /No findings filed/);
  assert.match(html, /without creating or updating a report/);
  assert.match(html, /data-artifact="Run\/close-out.md"[^>]*>Read results &amp; explanation/);
  assert.match(html, /SQL analysis only/);
  assert.match(html, /does not review individual sessions/);
  assert.ok(html.indexOf("No findings filed") < html.indexOf("Run progress"));
  assert.doesNotMatch(html, /- Run ID/);
  assert.match(runList([job]), /No findings filed/);
});

test("nonempty outcomes count new and updated findings and offer the inbox", () => {
  const html = jobView({ ...job, selection: { runner: "claude" }, result: { ...job.result, reports: [{ key: "checkout", kind: "new" }, { key: "pricing", kind: "updated" }], memory: [{ key: "noise/test", kind: "new" }] } });
  assert.match(html, /2 findings filed/);
  assert.match(html, /1 new · 1 updated · 1 memory update/);
  assert.match(html, /data-page="findings"[^>]*>View findings/);
  assert.doesNotMatch(html, /SQL analysis only|No findings filed/);
});

test("missing PostHog and timed-out runs never claim a completed empty investigation", () => {
  for (const result of [{ ...job.result, mcp: "missing" }, { ...job.result, timedOut: true }]) {
    const current = { ...job, status: "needs_attention", result };
    const html = jobView(current);
    assert.match(html, /Investigation incomplete/);
    assert.doesNotMatch(html, /No findings filed|completed without/);
    assert.doesNotMatch(runList([current]), /No findings filed/);
  }
});

test("running, failed, stopped and unrelated operations do not get a success summary", () => {
  for (const status of ["running", "failed", "stopped"]) assert.doesNotMatch(jobView({ ...job, status }), /data-key="scout-outcome"/);
  assert.doesNotMatch(jobView({ ...job, kind: "setup" }), /data-key="scout-outcome"/);
  assert.doesNotMatch(jobView({ ...job, result: {} }), /data-key="scout-outcome"/);
});

test("outcome actions use available artifacts and escape their keys", () => {
  assert.doesNotMatch(jobView({ ...job, artifacts: [] }), /data-artifact=/);
  const html = jobView({ ...job, artifacts: [{ key: 'Run/" onclick="bad/close-out.md' }] });
  assert.doesNotMatch(html, / onclick="bad/);
});

test("Codex launch readiness explains the lack of session review before launch", () => {
  const state = { jobs: [], workspace: { initialized: true, confirmed: true, config: { posthog: { projectId: "123", host: "us" } } }, connections: { codex: { authenticated: true, models: [{ id: selection.model, available: true, efforts: ["high"] }], mcp: [{ connected: true }] } } };
  const ready = readiness(state, selection);
  assert.equal(ready.ready, true);
  assert.match(ready.detail, /SQL analysis only/);
  assert.match(ready.detail, /Claude Code/);
});

test("View findings restores the open list after viewing a report or archived findings", async () => {
  const html = jobView({ ...job, result: { ...job.result, reports: [{ key: "checkout", kind: "new" }] } });
  const action = html.match(/<button[^>]*>View findings<\/button>/)[0];
  const dataset = Object.fromEntries([...action.matchAll(/data-([a-z]+)="([^"]+)"/g)].map(([, key, value]) => [key, value]));
  const source = readFileSync(new URL("../src/ui/web/app.js", import.meta.url), "utf8");
  const dispatcher = source.slice(source.indexOf('document.addEventListener("click"'), source.indexOf('$("close-artifact").addEventListener'));
  for (const priorFilter of ["open", "archived"]) for (const detailOpen of [false, true]) {
    const elements = { "report-detail": { hidden: !detailOpen }, "finding-list": { hidden: detailOpen } };
    const tabs = ["open", "archived"].map(filter => ({ dataset: { filter }, setAttribute(name, value) { this[name] = value; } }));
    let click, renderedFilter;
    const context = {
      filter: priorFilter, report: detailOpen ? { slug: "old-report" } : null, page: "job",
      $: id => elements[id], protect: action => action,
      document: { addEventListener(_type, handler) { click = handler; }, querySelectorAll(selector) { assert.equal(selector, ".tabs [data-filter]"); return tabs; } },
      navigate(page) { context.page = page; }, renderState() { renderedFilter = context.filter; },
    };
    runInNewContext(dispatcher, context);
    await click({ target: { closest: () => ({ dataset }) } });
    assert.equal(context.page, "findings");
    assert.equal(context.report, null);
    assert.equal(renderedFilter, "open");
    assert.equal(elements["report-detail"].hidden, true);
    assert.equal(elements["finding-list"].hidden, false);
    assert.deepEqual(tabs.map(tab => tab["aria-pressed"]), ["true", "false"]);
  }
});
