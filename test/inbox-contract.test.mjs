import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { trashFixture } from "./helpers/cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { takeFlag, takeOption } from "../src/argv.mjs";
import {
  DRAFT_PLACEHOLDER_LINE,
  assertDraftAllowed,
  buildDraftPrompt,
  missingSections,
  posthogDraftReady,
  sealDraft,
} from "../src/context-draft.mjs";
import { main } from "../src/cli.mjs";
import {
  parseCandidates,
  shouldRunPhase2,
} from "../src/candidates.mjs";
import { POSTHOG_CLOUD, initConfig, loadConfig, pkgRoot, resolveHost } from "../src/config.mjs";
import { PLACEHOLDER, assertContextReady } from "../src/context.mjs";
import { decline } from "../src/decline.mjs";
import { assertReady, collectChecks, collectPrChecks, formatDoctor, posthogMcpOk } from "../src/doctor.mjs";
import { formatInboxLine, listInbox, parseReport, showReport } from "../src/inbox.mjs";
import { formatIndex, parseKey, remember } from "../src/memory.mjs";
import { buildPrPrompt } from "../src/pr.mjs";
import { parseSource, resolveSource } from "../src/pr-source.mjs";
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
  for (const dir of dirs.splice(0)) trashFixture(dir);
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
  assert.equal(loadConfig().posthog.host, "YOUR_REGION");
  assert.equal(loadConfig().read.effort, "low");
  assert.equal(loadConfig().read.model, "");
});

test("resolveHost accepts us or eu, nothing else", () => {
  assert.equal(resolveHost("us"), POSTHOG_CLOUD.us);
  assert.equal(resolveHost("EU"), POSTHOG_CLOUD.eu);
  assert.equal(resolveHost("https://eu.posthog.com/"), POSTHOG_CLOUD.eu);
  assert.equal(resolveHost("YOUR_REGION"), "");
  assert.equal(resolveHost("https://app.posthog.com"), "");
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
  assert.match(prompt, /priority: P1\|P2\|P3/);
  assert.match(prompt, /templates\/report\.md/);
  assert.match(prompt, /PHASE 1/);
  assert.match(prompt, /friction-candidates\.json/);
  assert.match(prompt, /session_replay_features/);
  assert.match(prompt, /rageclicks_24h/);
  assert.match(prompt, /argMinMerge/);
  assert.match(prompt, /session-recording-summaries-list/);
  assert.match(prompt, /Series markdown table/);
  assert.match(prompt, /Query section with that HogQL/);
  assert.doesNotMatch(prompt, /scratchpad\.md/);
  assert.doesNotMatch(prompt, /inbox\/findings/);
});

test("report template has a Series table", () => {
  const text = readFileSync(join(pkgRoot(), "templates", "report.md"), "utf8");
  assert.match(text, /^## Series$/m);
  assert.match(text, /numerator/);
  assert.match(text, /^## Query$/m);
  assert.match(text, /```sql/);
});

test("phase 2 prompt gets candidates; shouldRunPhase2 is Claude-only", () => {
  tmp();
  initConfig();
  fillContext();
  const candidates = parseCandidates({
    windowDays: 7,
    ids: [
      { sessionId: "aaa", signals: 3, paths: ["/checkout"] },
      { id: "bbb", signals: 9, paths: ["/pricing"] },
      { sessionId: "", signals: 99 },
    ],
  });
  assert.deepEqual(
    candidates.ids.map((r) => r.sessionId),
    ["bbb", "aaa"],
  );
  const cfg = { posthog: { projectId: "123", host: "https://us.posthog.com" }, runner: "claude" };
  const p2 = buildPrompt(loadSkill("friction"), cfg, { phase: 2, candidates });
  assert.match(p2, /PHASE 2/);
  assert.match(p2, /sub-agents/);
  assert.match(p2, /session_replay_features/);
  assert.match(p2, /session-recording-summaries-list/);
  assert.match(p2, /"sessionId": "bbb"/);
  assert.equal(shouldRunPhase2(cfg, candidates, "# ok\n"), true);
  assert.equal(shouldRunPhase2({ ...cfg, runner: "cursor" }, candidates, "# ok\n"), false);
  assert.equal(shouldRunPhase2(cfg, { ids: [] }, "# ok\n"), false);
  assert.equal(shouldRunPhase2(cfg, candidates, "no PostHog tools\n"), false);
});

test("inbox lists P1 before P3 as priority slug title", () => {
  tmp();
  initConfig();
  mkdirSync(".rusubon/inbox/reports", { recursive: true });
  writeFileSync(
    ".rusubon/inbox/reports/vision-gap.md",
    "# Vision obs collapsed\n\npriority: P3\npriority_explanation: obs_7d is 0 while 400 recordings flowed.\nactionability: requires_human_input\n",
  );
  writeFileSync(
    ".rusubon/inbox/reports/capture-cliff.md",
    "# Capture ratio 12% of 14d norm\n\npriority: P1\npriority_explanation: Capture fell to 12% of the 14d norm, traffic held.\nactionability: requires_human_input\n",
  );
  writeFileSync(".rusubon/inbox/reports/old-note.md", "# No priority yet\n\nlegacy\n");
  const items = listInbox();
  assert.deepEqual(
    items.map((i) => formatInboxLine(i)),
    [
      "P1  capture-cliff  Capture ratio 12% of 14d norm",
      "P3  vision-gap  Vision obs collapsed",
      "—  old-note  No priority yet",
    ],
  );
  const parsed = parseReport(items[0].path ? readFileSync(items[0].path, "utf8") : "", "");
  assert.equal(parsed.priority, "P1");
  assert.match(parsed.priorityExplanation, /12%/);
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
  assert.match(formatDoctor(checks), /fail\s+host/);
});

test("doctor fails a host that is not us or eu", () => {
  tmp();
  initConfig();
  fillContext();
  writeFileSync(
    "rusubon.json",
    JSON.stringify({ posthog: { projectId: "123", host: "https://app.posthog.com" }, runner: "claude" }, null, 2) +
      "\n",
  );
  const checks = collectChecks(loadConfig(), okProbes);
  assert.match(formatDoctor(checks), /fail\s+host/);
  writeFileSync(
    "rusubon.json",
    JSON.stringify({ posthog: { projectId: "123", host: "eu" }, runner: "claude" }, null, 2) + "\n",
  );
  assert.equal(loadConfig().posthog.host, POSTHOG_CLOUD.eu);
  assert.doesNotThrow(() => assertReady(loadConfig(), okProbes));
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
  assert.match(text, /—  paywall-eu \(new\)/);
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
  assert.deepEqual(takeFlag(["draft", "--force", "x"], "force"), {
    rest: ["draft", "x"],
    present: true,
  });
});

test("context draft prompt is fail-closed and scout-shaped", () => {
  const empty = {
    posthog: { projectId: "YOUR_PROJECT_ID", host: "YOUR_REGION" },
    runner: "claude",
  };
  const bare = buildDraftPrompt(empty, "");
  assert.match(bare, /RUSUBON_CONTEXT_PLACEHOLDER/);
  assert.match(bare, /# Money paths/);
  assert.match(bare, /untrusted/);
  assert.doesNotMatch(bare, /channel-instructions-update/);
  assert.doesNotMatch(bare, /Conventions & gotchas/);
  assert.doesNotMatch(bare, /Related PostHog resources/);
  assert.equal(posthogDraftReady(empty), false);

  const ready = {
    posthog: { projectId: "123", host: "https://us.posthog.com" },
    runner: "claude",
  };
  const seeded = buildDraftPrompt(ready, "Feature flags help teams roll out.");
  assert.match(seeded, /Feature flags help teams roll out/);
  assert.match(seeded, /\$pageview/);
  assert.match(seeded, /project_id 123/);
  assert.equal(posthogDraftReady(ready), true);
});

test("sealDraft always restores the placeholder", () => {
  const sealed = sealDraft("# Product\nA demo.\n\n# Money paths\n- /checkout\n");
  assert.ok(sealed.startsWith(DRAFT_PLACEHOLDER_LINE));
  assert.match(sealed, /# Product/);
  assert.deepEqual(missingSections(sealed), ["# Intentional friction", "# Out of scope"]);
  const twice = sealDraft(`${DRAFT_PLACEHOLDER_LINE}\n\n# Product\n`);
  assert.equal(twice.indexOf(PLACEHOLDER), twice.lastIndexOf(PLACEHOLDER));
});

test("assertDraftAllowed refuses a filled context without --force", () => {
  assert.doesNotThrow(() => assertDraftAllowed("", false));
  assert.doesNotThrow(() => assertDraftAllowed(`${PLACEHOLDER}\n# Product\n`, false));
  assert.throws(() => assertDraftAllowed("# Product\nfilled\n", false), /already filled/);
  assert.doesNotThrow(() => assertDraftAllowed("# Product\nfilled\n", true));
});

test("parseSource accepts URL, owner/repo#N, #12, 12, slug; flags conflict", () => {
  assert.deepEqual(parseSource("https://github.com/acme/app/issues/12"), {
    kind: "issue",
    owner: "acme",
    repo: "app",
    number: 12,
  });
  assert.deepEqual(parseSource("acme/app#12"), {
    kind: "issue",
    owner: "acme",
    repo: "app",
    number: 12,
  });
  assert.deepEqual(parseSource("#12"), { kind: "issue", number: 12 });
  assert.deepEqual(parseSource("12"), { kind: "issue", number: 12 });
  assert.deepEqual(parseSource("checkout-gate"), { kind: "report", slug: "checkout-gate" });
  assert.deepEqual(parseSource("12", { report: true }), { kind: "report", slug: "12" });
  assert.deepEqual(parseSource("acme/app#12", { issue: true }), {
    kind: "issue",
    owner: "acme",
    repo: "app",
    number: 12,
  });
  assert.throws(() => parseSource("checkout-gate", { issue: true, report: true }), /--issue|--report|not both/);
});

test("buildPrPrompt mentions writing-pr-descriptions, --draft, no merge, five passes", () => {
  const prompt = buildPrPrompt(
    { kind: "report", slug: "checkout-gate", body: "# Checkout gate\n\nstep vs baseline\n" },
    { runner: "claude", posthog: { projectId: "YOUR_PROJECT_ID", host: "YOUR_REGION" } },
  );
  assert.match(prompt, /writing-pr-descriptions/);
  assert.match(prompt, /--draft/);
  assert.match(prompt, /[Nn]ever merge|no merge/);
  assert.match(prompt, /five passes/);
  assert.doesNotMatch(prompt, /RUSUBON_CONTEXT_PLACEHOLDER/);
});

test("main run research rejects with rusubon pr", async () => {
  await assert.rejects(() => main(["run", "research"]), /rusubon pr/);
});

test("collectPrChecks does not include mcp/project; fails without gh", () => {
  tmp();
  initConfig();
  const checks = collectPrChecks(loadConfig(), okProbes);
  assert.equal(checks.some((c) => c.name === "mcp"), false);
  assert.equal(checks.some((c) => c.name === "project"), false);
  assert.equal(checks.some((c) => c.name === "host"), false);
  assert.equal(checks.some((c) => c.name === "context"), false);
  assert.match(formatDoctor(checks), /fail\s+gh/);
});

test("resolveSource report reads inbox file", () => {
  tmp();
  initConfig();
  writeFileSync(".rusubon/inbox/reports/checkout-gate.md", "# Checkout gate\n\nstep vs baseline\n");
  const src = resolveSource(parseSource("checkout-gate"), {});
  assert.equal(src.kind, "report");
  assert.equal(src.slug, "checkout-gate");
  assert.match(src.body, /step vs baseline/);
});

test("resolveSource issue mismatches repo", () => {
  const probes = {
    ghRepo: () => ({ status: 0, out: JSON.stringify({ nameWithOwner: "acme/app" }) }),
    ghIssue: () => ({ status: 0, out: JSON.stringify({ number: 9, title: "x", body: "y" }) }),
  };
  assert.throws(
    () => resolveSource(parseSource("other/repo#9"), probes),
    /run from that checkout/,
  );
});

test("friction buildPrompt still says no PR / no GitHub", () => {
  tmp();
  initConfig();
  fillContext();
  const prompt = buildPrompt(loadSkill("friction"), {
    posthog: { projectId: "123", host: "https://us.posthog.com" },
    runner: "claude",
  });
  assert.match(prompt, /no PR/i);
  assert.match(prompt, /no GitHub/i);
  assert.match(prompt, /Never open a PR/);
});

test("writing-pr-descriptions SKILL exists and mentions Pass 1 and Agent context", () => {
  const text = readFileSync(join(pkgRoot(), "skills", "writing-pr-descriptions", "SKILL.md"), "utf8");
  assert.match(text, /Pass 1/);
  assert.match(text, /Agent context/);
});
