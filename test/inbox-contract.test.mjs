import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { takeOption } from "../src/argv.mjs";
import { main } from "../src/cli.mjs";
import { initConfig, loadConfig } from "../src/config.mjs";
import { PLACEHOLDER, assertContextReady } from "../src/context.mjs";
import { decline } from "../src/decline.mjs";
import { assertReady, collectChecks, formatDoctor, posthogMcpOk } from "../src/doctor.mjs";
import { listInbox, showReport } from "../src/inbox.mjs";
import { formatIndex, parseKey, remember } from "../src/memory.mjs";
import { buildPrompt, loadSkill } from "../src/run.mjs";
import { formatDuration, formatRunSummary, snapshotState, summarizeRun } from "../src/summary.mjs";

const prev = process.cwd();
const dirs = [];

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "rusubon-"));
  dirs.push(dir);
  process.chdir(dir);
  return dir;
}

afterEach(() => {
  process.chdir(prev);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fillContext() {
  writeFileSync(
    join(process.cwd(), ".rusubon", "context.md"),
    `# Product\nA demo app.\n\n# Money paths\n- /checkout\n\n# Intentional friction\n- paywall after free quota\n\n# Out of scope\n- staging\n`,
  );
}

function writeProject(id = "123") {
  writeFileSync(
    "rusubon.json",
    JSON.stringify({ posthog: { projectId: id, host: "https://us.posthog.com" }, runner: "claude" }, null, 2) + "\n",
  );
}

const okProbes = {
  which: () => "/usr/bin/claude",
  claudeAuth: () => ({ loggedIn: true, raw: "" }),
  claudeMcpList: () => "posthog: https://mcp.posthog.com/mcp (HTTP) - ✔ Connected",
  agentStatus: () => "Logged in as someone",
  agentMcpList: () => "",
};

test("parseKey rejects dates and traversal", () => {
  assert.deepEqual(parseKey("noise/paywall-eu"), {
    prefix: "noise",
    slug: "paywall-eu",
    key: "noise/paywall-eu",
  });
  assert.throws(() => parseKey("noise/2026-08-17-paywall"), /dates go in the body/);
  assert.throws(() => parseKey("pattern/../secret"), /bad memory key/);
  assert.throws(() => parseKey("weird/foo"), /bad memory key/);
});

test("init scaffolds .rusubon and never writes .mcp.json", () => {
  tmp();
  initConfig();
  assert.ok(existsSync("rusubon.json"));
  assert.ok(existsSync(".rusubon/context.md"));
  assert.ok(readFileSync(".rusubon/context.md", "utf8").includes(PLACEHOLDER));
  assert.ok(existsSync(".rusubon/memory/pattern/.gitkeep"));
  assert.ok(existsSync(".rusubon/memory/noise/.gitkeep"));
  assert.ok(existsSync(".rusubon/inbox/reports"));
  assert.ok(existsSync(".rusubon/inbox/archive"));
  assert.ok(existsSync(".rusubon/runs"));
  assert.ok(existsSync("rusubon.mcp.example.json"));
  assert.equal(existsSync(".mcp.json"), false);
  const gi = readFileSync(".gitignore", "utf8");
  assert.match(gi, /\.rusubon\/inbox\//);
  assert.match(gi, /\.rusubon\/runs\//);
  assert.equal(loadConfig().runner, "claude");
});

test("run refuses placeholder context", async () => {
  tmp();
  initConfig();
  assert.throws(() => assertContextReady(), /placeholder/);
  await assert.rejects(() => main(["run", "friction"]), /placeholder/);
  fillContext();
  assert.doesNotThrow(() => assertContextReady());
  await assert.rejects(() => main(["run", "friction"]), /projectId/);
});

test("remember upserts; friction index restricts prefixes over cap", () => {
  tmp();
  initConfig();
  remember("pattern/capture-baseline", "still quiet this week");
  remember("noise/paywall-eu", "intentional EU checkout gate");
  remember("report/old-note", "should not appear in friction index");
  const again = remember("pattern/capture-baseline", "refreshed baseline");
  assert.match(readFileSync(again.path, "utf8"), /refreshed baseline/);
  const index = formatIndex("friction");
  assert.match(index, /pattern\/capture-baseline — refreshed baseline/);
  assert.match(index, /noise\/paywall-eu/);
  assert.match(index, /report\/old-note/);
  const tight = formatIndex("friction", 2);
  assert.match(tight, /pattern\/capture-baseline/);
  assert.doesNotMatch(tight, /report\/old-note/);
});

test("decline archives the report and writes memory/noise", () => {
  tmp();
  initConfig();
  mkdirSync(".rusubon/inbox/reports", { recursive: true });
  writeFileSync(".rusubon/inbox/reports/paywall-eu.md", "# Paywall EU\n\nnot a bug\n");
  const result = decline("paywall-eu.md", "intentional EU checkout gate");
  assert.equal(existsSync(".rusubon/inbox/reports/paywall-eu.md"), false);
  assert.ok(existsSync(result.archive));
  const noise = readFileSync(".rusubon/memory/noise/paywall-eu.md", "utf8");
  assert.match(noise, /intentional EU checkout gate/);
  assert.match(noise, /If this shape returns unchanged/);
  assert.equal(listInbox().length, 0);
  assert.throws(() => decline("paywall-eu", "again"), /no open report/);
});

test("buildPrompt injects context and memory index", () => {
  tmp();
  initConfig();
  fillContext();
  remember("noise/paywall-eu", "intentional EU checkout gate");
  const prompt = buildPrompt(loadSkill("friction"), {
    posthog: { projectId: "123", host: "https://us.posthog.com" },
    runner: "claude",
  });
  assert.match(prompt, /paywall after free quota/);
  assert.match(prompt, /noise\/paywall-eu — intentional EU checkout gate/);
  assert.match(prompt, /no PostHog tools/);
  assert.match(prompt, /\.rusubon\/inbox\/reports/);
  assert.doesNotMatch(prompt, /scratchpad\.md/);
  assert.doesNotMatch(prompt, /inbox\/findings/);
});

test("cli remember and decline --why", async () => {
  tmp();
  initConfig();
  fillContext();
  writeFileSync(".rusubon/inbox/reports/checkout-gate.md", "# Checkout gate\n");
  await main(["remember", "pattern/money-paths", "checkout and pricing"]);
  assert.match(readFileSync(".rusubon/memory/pattern/money-paths.md", "utf8"), /checkout and pricing/);
  await main(["decline", "checkout-gate", "--why", "intentional quota paywall"]);
  assert.equal(existsSync(".rusubon/inbox/reports/checkout-gate.md"), false);
  assert.ok(existsSync(".rusubon/inbox/archive/checkout-gate.md"));
  assert.match(readFileSync(".rusubon/memory/noise/checkout-gate.md", "utf8"), /intentional quota paywall/);
});

test("doctor fails local checks before probing the runner", () => {
  tmp();
  initConfig();
  const checks = collectChecks(loadConfig(), okProbes);
  assert.equal(checks.some((c) => c.name === "mcp"), false);
  assert.match(formatDoctor(checks), /fail\s+context/);
  assert.match(formatDoctor(checks), /fail\s+project/);
});

test("doctor and assertReady accept a ready tree with stub probes", () => {
  tmp();
  initConfig();
  fillContext();
  writeProject("123");
  const checks = collectChecks(loadConfig(), okProbes);
  assert.deepEqual(
    checks.filter((c) => !c.ok),
    [],
  );
  assert.doesNotThrow(() => assertReady(loadConfig(), okProbes));
  assert.throws(
    () =>
      assertReady(loadConfig(), {
        ...okProbes,
        claudeMcpList: () => "codex-search: connected",
      }),
    /PostHog MCP/,
  );
});

test("posthogMcpOk reads claude mcp list lines", () => {
  assert.equal(
    posthogMcpOk("posthog: https://mcp.posthog.com/mcp (HTTP) - ✔ Connected"),
    true,
  );
  assert.equal(posthogMcpOk("codex-search: ✔ Connected"), false);
  assert.equal(posthogMcpOk("posthog: https://mcp.posthog.com/mcp - Failed"), false);
});

test("show prints an open or archived report", async () => {
  tmp();
  initConfig();
  writeFileSync(".rusubon/inbox/reports/checkout-gate.md", "# Checkout gate\n\nstep vs baseline\n");
  const open = showReport("checkout-gate");
  assert.equal(open.where, "reports");
  assert.match(open.body, /step vs baseline/);
  await main(["decline", "checkout-gate", "--why", "intentional"]);
  const archived = showReport("checkout-gate.md");
  assert.equal(archived.where, "archive");
});

test("harness summary diffs reports, memory, and close-out", () => {
  tmp();
  initConfig();
  fillContext();
  remember("pattern/capture-baseline", "old");
  const before = snapshotState();
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(".rusubon/inbox/reports/paywall-eu.md", "# Paywall\n");
  remember("pattern/capture-baseline", "refreshed");
  remember("pattern/frustration-mean-is-mix", "mix not friction");
  writeFileSync(
    `.rusubon/runs/${today}-friction.md`,
    "# friction\n\nCapture is steady and in-band.\n",
  );
  const summary = summarizeRun({ skillName: "friction", startedAt: Date.now() - 133000, before });
  assert.equal(summary.mcp, "ok");
  assert.equal(summary.closeOut, `.rusubon/runs/${today}-friction.md`);
  assert.match(summary.closeLine, /Capture is steady/);
  assert.equal(formatDuration(133000), "2m13s");
  const text = formatRunSummary(summary);
  assert.match(text, /friction  2m13s  mcp=ok/);
  assert.match(text, /reports   1/);
  assert.match(text, /paywall-eu \(new\)/);
  assert.match(text, /pattern\/frustration-mean-is-mix \(new\)/);
  assert.match(text, /pattern\/capture-baseline \(updated\)/);
});

test("close-out starting with no PostHog tools is mcp=missing", () => {
  tmp();
  initConfig();
  const before = snapshotState();
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(`.rusubon/runs/${today}-friction.md`, "no PostHog tools\n\nstopped.\n");
  const summary = summarizeRun({ skillName: "friction", startedAt: Date.now(), before });
  assert.equal(summary.mcp, "missing");
  assert.equal(summary.reports.length, 0);
});

test("takeOption parses --why", () => {
  assert.deepEqual(takeOption(["paywall-eu", "--why", "because"], "why"), {
    rest: ["paywall-eu"],
    value: "because",
  });
  assert.deepEqual(takeOption(["--why=because", "paywall-eu"], "why"), {
    rest: ["paywall-eu"],
    value: "because",
  });
});
