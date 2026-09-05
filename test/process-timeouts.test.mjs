import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { RUNNERS, runWith } from "../src/runners.mjs";
import { buildPrPrompt } from "../src/pr-prompt.mjs";
import { verifyImplementation } from "../src/pr-verification.mjs";
import { fixture } from "./helpers/pr-fixture.mjs";

/** Make a real subprocess record readiness and any caught termination signal. */
function stubbornScript(ready, handled) {
  return `const {writeFileSync} = require('node:fs');
process.on('SIGTERM', () => writeFileSync(${JSON.stringify(handled)}, 'handled'));
writeFileSync(${JSON.stringify(ready)}, 'ready');
setTimeout(() => process.exit(0), 6000);
`;
}

for (const runner of ["claude", "cursor", "codex"]) {
  test(`${runner} runner timeout terminates a CLI that ignores SIGTERM`, () => {
    const f = fixture();
    const previous = { cwd: process.cwd(), path: process.env.PATH, which: RUNNERS[runner].which, claude: process.env.RUSUBON_CLAUDE };
    const ready = join(f.root, "ready");
    const handled = join(f.root, "handled");
    const bin = join(f.root, "bin", runner === "cursor" ? "agent" : runner);
    writeFileSync(bin, `#!${process.execPath}\n${stubbornScript(ready, handled)}`, { mode: 0o755 });
    try {
      process.chdir(f.repo);
      process.env.PATH = join(f.root, "bin") + ":" + previous.path;
      if (runner === "claude") process.env.RUSUBON_CLAUDE = bin;
      RUNNERS[runner].which = () => bin;
      const result = runWith(runner, "timeout regression", { phase: "research", timeoutMs: 2000 });
      assert.ok(existsSync(ready), "runner installed its signal handler");
      assert.ok(!existsSync(handled), "timeout must not rely on SIGTERM");
      assert.equal(result.timedOut, true);
    } finally {
      process.chdir(previous.cwd);
      process.env.PATH = previous.path;
      if (previous.claude === undefined) delete process.env.RUSUBON_CLAUDE;
      else process.env.RUSUBON_CLAUDE = previous.claude;
      RUNNERS[runner].which = previous.which;
      f.cleanup();
    }
  });
}

test("verification timeout terminates a command ignoring SIGTERM without issuing a receipt", async () => {
  const f = fixture();
  const previousCwd = process.cwd();
  const runId = "timeout-test";
  const runDir = join(f.repo, ".rusubon/runs", runId);
  const ready = join(runDir, "ready");
  const handled = join(runDir, "handled");
  try {
    process.chdir(f.repo);
    mkdirSync(runDir, { recursive: true });
    for (const phase of ["research", "implementation"]) {
      const prompt = buildPrPrompt({ kind: "report", slug: "retry" }, { runner: "codex" }, {
        phase, runId, runDir: `.rusubon/runs/${runId}`, specPath: `docs/plans/${runId}`,
      });
      await f.run("codex", prompt, {});
    }
    const statePath = join(f.latest.specDir, ".spec-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.verification[0].argv = [process.execPath, "-e", stubbornScript(ready, handled)];
    writeFileSync(statePath, JSON.stringify(state));
    assert.throws(() => verifyImplementation({ repo: f.repo, specDir: f.latest.specDir, runDir,
      runId, source: "retry", timeoutMs: 2000 }), /ETIMEDOUT/);
    assert.ok(existsSync(ready), "verification command installed its signal handler");
    assert.ok(!existsSync(handled), "timeout must not rely on SIGTERM");
    assert.ok(!existsSync(join(runDir, "verification.json")));
  } finally {
    process.chdir(previousCwd);
    f.cleanup();
  }
});
