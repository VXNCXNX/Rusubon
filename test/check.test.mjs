import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { trashFixture } from "./helpers/cleanup.mjs";
import { buildCheckPrompt, checkReport, extractReportQueries, hasCheckHeading } from "../src/check.mjs";
import { initConfig, loadConfig } from "../src/config.mjs";
import { reportRel, showReport } from "../src/inbox.mjs";

const prev = process.cwd();
const dirs = [];
function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "rusubon-check-"));
  dirs.push(dir);
  process.chdir(dir);
  return dir;
}
afterEach(() => {
  process.chdir(prev);
  for (const dir of dirs.splice(0)) trashFixture(dir);
});

const reportBody = `# Checkout exceptions 3x baseline

priority: P2
priority_explanation: /checkout exceptions rose from 12 to 41 across 9 persons.
actionability: requires_human_input

## Series

| day | errors |
| --- | --- |
| 2026-09-01 | 41 |

## Query

\`\`\`sql
SELECT 1
\`\`\`

\`\`\`sql
SELECT 2
\`\`\`
`;

function ready() {
  initConfig();
  writeFileSync(".rusubon/context.md", "# Product\nDemo\n\n# Money paths\n/checkout\n\n# Intentional friction\nNone\n\n# Out of scope\nStaging\n");
  writeFileSync("rusubon.json", JSON.stringify({ posthog: { projectId: "123", host: "eu" }, runner: "claude" }, null, 2) + "\n");
  mkdirSync(".rusubon/inbox/reports", { recursive: true });
  writeFileSync(".rusubon/inbox/reports/checkout-exceptions.md", reportBody);
}

const probes = { which: () => "/usr/bin/claude", claudeAuth: () => ({ loggedIn: true }), claudeMqpList: () => "posthog: connected", claudeMcpList: () => "posthog: connected" };

test("extractReportQueries reads every sql fence under Query", () => {
  assert.deepEqual(extractReportQueries(reportBody), ["SELECT 1", "SELECT 2"]);
  assert.deepEqual(extractReportQueries("# No query\n"), []);
  assert.equal(hasCheckHeading("## Check 2026-09-14\nverdict: quiet\n", "2026-09-14T12:00:00.000Z"), true);
  assert.equal(hasCheckHeading("## Check 2026-09-13\n", "2026-09-14T12:00:00.000Z"), false);
});

test("check refuses a report without Query HogQL", async () => {
  tmp();
  ready();
  writeFileSync(".rusubon/inbox/reports/empty.md", "# Empty\n\npriority: P3\npriority_explanation: n\nactionability: requires_human_input\n");
  await assert.rejects(checkReport("empty", loadConfig(), probes, { run: async () => ({ status: 0 }) }), /no Query HogQL/);
});

test("check appends today's heading and records a quiet verdict", async () => {
  tmp();
  ready();
  const today = new Date().toISOString().slice(0, 10);
  const result = await checkReport("checkout-exceptions", loadConfig(), probes, {
    runId: "check-test",
    run: async (_runner, prompt) => {
      assert.match(prompt, /SELECT 1/);
      assert.match(prompt, /not a scout/);
      const report = showReport("checkout-exceptions");
      writeFileSync(report.path, `${report.body.trim()}\n\n## Check ${today}\nverdict: quiet\nStill at baseline.\n\n## Series\n\n| day | errors |\n| --- | --- |\n| ${today} | 2 |\n\n## Query\n\n\`\`\`sql\nSELECT 3\n\`\`\`\n`);
      writeFileSync(".rusubon/runs/check-test/close-out.md", "Re-ran the checkout exception query. quiet.\n");
      return { status: 0 };
    },
  });
  assert.equal(result.slug, "checkout-exceptions");
  assert.equal(result.verdict, "quiet");
  assert.equal(result.missingTools, false);
  assert.match(showReport("checkout-exceptions").body, new RegExp(`## Check ${today}`));
  assert.equal(reportRel(showReport("checkout-exceptions")), ".rusubon/inbox/reports/checkout-exceptions.md");
});

test("check prompt names the report path", () => {
  tmp();
  ready();
  const prompt = buildCheckPrompt({
    report: showReport("checkout-exceptions"),
    queries: ["SELECT 1"],
    config: loadConfig(),
    closeOut: ".rusubon/runs/x/close-out.md",
    today: "2026-09-14",
  });
  assert.match(prompt, /\.rusubon\/inbox\/reports\/checkout-exceptions\.md/);
  assert.match(prompt, /verdict: still_live \| quiet/);
});
