import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../../skills/spec/scripts/evidence.mjs";
import { trashFixture } from "./cleanup.mjs";

/** Create a temporary product checkout and bare remote with a simulated two-phase runner.
 * Return runner state, recorded GitHub calls and trash-based fixture cleanup. */
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rusubon-pr-test-"));
  const repo = join(root, "product");
  mkdirSync(repo); mkdirSync(join(root, "bin"));
  const ghLog = join(root, "gh.jsonl");
  writeFileSync(join(root, "bin/gh"), `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify(args)+'\\n');
if(args[0]==='repo') console.log(JSON.stringify({nameWithOwner:'acme/app'}));
if(args[0]==='issue') console.log(JSON.stringify({number:12,title:'Retry is disabled',body:'Failed search prevents retry'}));
if(args[0]==='pr' && args[1]==='create') console.log('https://github.com/acme/app/pull/99');
`, { mode: 0o755 });
  // The executable has no extension, so force CommonJS rather than depend on Node syntax detection.
  const shim = readFileSync(join(root, "bin/gh"), "utf8").replace("import {appendFileSync} from 'node:fs';", "const {appendFileSync}=require('node:fs');");
  writeFileSync(join(root, "bin/gh"), shim);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.test"]);
  git(repo, ["config", "user.name", "Rusubon test"]);
  writeFileSync(join(repo, ".gitignore"), ".rusubon/runs/\n.rusubon/inbox/\n");
  writeFileSync(join(repo, "retry.mjs"), "export const canRetry = (pending, failed) => !pending && !failed;\n");
  git(repo, ["add", "."]); git(repo, ["commit", "-m", "fixture"]);
  const remote = join(root, "remote.git");
  git(repo, ["init", "--bare", remote]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  mkdirSync(join(repo, ".rusubon/inbox/reports"), { recursive: true });
  writeFileSync(join(repo, ".rusubon/inbox/reports/retry.md"), "# Retry fails for 5 users\n");
  const calls = [];
  let latest;
  const run = async (_runner, prompt, options) => {
    const get = (key) => prompt.match(new RegExp(`^- ${key}: (.+)$`, "m"))[1];
    const runId = get("Run id"); const source = get("Source reference");
    const specPath = get("Spec directory"); const resultPath = get("Result file");
    const specDir = join(repo, specPath); const phase = get("Phase");
    calls.push(phase);
    latest = { runId, source, specPath, specDir, resultPath: join(repo, resultPath), options };
    if (phase === "research") {
      mkdirSync(specDir, { recursive: true });
      const state = { mode: "auto", type: "bug", tier: 1, run_id: runId, source,
        risk_reason: "One local retry state", decisions: [],
        verification: [{ id: "retry", kind: "test", format: "tap", cwd: ".",
          argv: [process.execPath, "--test", "--test-reporter=tap", "test/retry.test.mjs"] }] };
      writeFileSync(join(specDir, ".spec-state.json"), JSON.stringify(state));
      writeFileSync(join(specDir, "requirements.md"), "# Retry\n1.1 WHEN search fails THE SYSTEM SHALL allow retry.\n1.2 WHEN pending THE SYSTEM SHALL CONTINUE TO disable retry.\nProven by: `test/retry.test.mjs`\n\n## Out of scope\nAutomatic retry\n");
      writeFileSync(join(specDir, "design.md"), "# Design\nOnly pending disables retry.\n");
      writeFileSync(join(specDir, "tasks.md"), "- [ ] Correct retry and add regression tests\nFiles: `retry.mjs`, `test/retry.test.mjs`\nVerify: retry\n_Requirements: 1.1, 1.2_\n");
    } else {
      writeFileSync(join(repo, "retry.mjs"), "export const canRetry = (pending) => !pending;\n");
      mkdirSync(join(repo, "test"), { recursive: true });
      writeFileSync(join(repo, "test/retry.test.mjs"), "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {canRetry} from '../retry.mjs';\ntest('failed search permits retry',()=>assert.equal(canRetry(false,true),true));\ntest('pending request blocks retry',()=>assert.equal(canRetry(true,false),false));\n");
      writeFileSync(join(specDir, "tasks.md"), readFileSync(join(specDir, "tasks.md"), "utf8").replace("[ ]", "[x]"));
      const state = JSON.parse(readFileSync(join(specDir, ".spec-state.json"), "utf8"));
      state.closure = "implemented";
      writeFileSync(join(specDir, ".spec-state.json"), JSON.stringify(state));
    }
    writeFileSync(join(repo, resultPath), JSON.stringify({ run_id: runId, source, phase,
      verdict: "immediately_actionable", reason: "Pending state explains disabled retry",
      pr_title: "fix(search): allow retry after failure",
      pr_body: `## Problem\nFailed searches prevent retry.\n\n## Changes\nRestore retry after failure.\n\n## Agent context\nAuto spec: ${specPath}` }));
    return { status: 0 };
  };
  return { root, repo, calls, run, get latest() { return latest; },
    ghCalls: () => { try { return readFileSync(ghLog, "utf8").trim().split("\n").map(JSON.parse); } catch { return []; } },
    cleanup: () => trashFixture(root),
  };
}
