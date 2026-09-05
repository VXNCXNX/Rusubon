import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { buildPrPrompt } from "../src/pr.mjs";
import { loadSkill, runSkill, skillsDir } from "../src/run.mjs";
import { trashFixture } from "./helpers/cleanup.mjs";

const root = mkdtempSync(join(tmpdir(), "rusubon-spec-"));
const validator = fileURLToPath(new URL("../skills/spec/scripts/check-spec.mjs", import.meta.url));
after(() => trashFixture(root));

function fixture() {
  const repo = mkdtempSync(join(root, "product-"));
  const dir = join(repo, "docs", "plans", "retry");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  const state = {
    mode: "auto", type: "bug", tier: 1, run_id: "test-run",
    source: "acme/app#12", risk_reason: "Local state cleanup",
    verification: [{ id: "retry", kind: "test", format: "tap", cwd: ".", argv: ["npm", "test"] }],
    decisions: [{
      id: "cleanup", title: "Cleanup location", options: ["existing", "new"],
      recommended: "existing", answer: "existing", decided_by: "auto",
      why: "Existing function owns pending state", evidence: "src/search.mjs cleanup",
    }],
  };
  const requirements = "# Retry\n\n1.1 WHEN search fails THE SYSTEM SHALL allow retry.\n"
    + "1.2 WHEN search is pending THE SYSTEM SHALL CONTINUE TO disable retry.\n"
    + "  Proven by: `test/search.test.mjs`\n\n## Out of scope\nAutomatic retries.\n";
  const tasks = "# Tasks\n\n- [ ] Fix cleanup and test retry.\n"
    + "  Files: `src/search.mjs`, `test/search.test.mjs`\n"
    + "  Verify: retry\n  _Requirements: 1.1, 1.2_\n";
  const write = (name, value) => writeFileSync(join(dir, name), value);
  const save = () => write(".spec-state.json", JSON.stringify(state));
  save();
  write("requirements.md", requirements);
  write("design.md", "# Design\nReset pending in existing cleanup.\n");
  write("tasks.md", tasks);
  const run = (...flags) => {
    const result = spawnSync(process.execPath, [validator, dir, ...flags], { cwd: repo, encoding: "utf8" });
    return { status: result.status, output: result.stdout + result.stderr };
  };
  return { repo, dir, state, requirements, tasks, write, save, run };
}

test("bundled auto spec is composed between research and PR writing for each runner", () => {
  for (const runner of ["claude", "cursor", "codex"]) {
    const prompt = buildPrPrompt({ kind: "issue", number: 12, body: "Retry is disabled" }, { runner }, { context: "" });
    const research = prompt.indexOf("# Skill: research");
    const spec = prompt.indexOf("# Skill: spec (auto mode)");
    const writing = prompt.indexOf("# Skill: writing-pr-descriptions");
    assert.ok(research > 0 && spec > research && writing > spec);
    assert.ok(prompt.includes(loadSkill("spec").body));
    assert.ok(prompt.includes(join(skillsDir(), "spec")));
    assert.match(prompt, /Spec mode: auto/);
    assert.match(prompt, /--complete/);
    assert.match(prompt, /requires_human_input/);
    assert.match(prompt, /Never merge/);
  }
});

test("spec cannot run as a scout", async () => {
  await assert.rejects(runSkill("spec", {}), /not a scout/);
});

test("complete plan accepts auto recommendations and planned regression tests", () => {
  const result = fixture().run();
  assert.equal(result.status, 0, result.output);
});

test("non-regression proof paths share the task path-list syntax", () => {
  for (const name of ["test/data,legacy.mjs", "test/a`b.mjs"]) {
    const f = fixture();
    f.write("requirements.md", f.requirements.replace("`test/search.test.mjs`", JSON.stringify([name])));
    f.write("tasks.md", f.tasks.replace(/^  Files:.*$/m, `  Files: ${JSON.stringify(["src/search.mjs", name])}`));
    const result = f.run();
    assert.equal(result.status, 0, result.output);
  }
});

test("quick specs reject design files that are outside their validated file set", () => {
  const f = fixture();
  f.state.type = "quick"; f.save();
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.output, /unexpected spec entry: design.md/);
});

test("task groups can use headings while each task retains its own declarations", () => {
  const f = fixture();
  f.write("tasks.md", "# Work\n\n## Retry\n" + f.tasks
    + "\n## Documentation\n- [ ] Document retry\nFiles: `README.md`\nVerify: retry\n_Requirements: enabler_\n");
  const result = f.run();
  assert.equal(result.status, 0, result.output);
});

test("empty plan and malformed state fail closed", () => {
  const f = fixture();
  f.write(".spec-state.json", "null");
  f.write("requirements.md", "# Empty");
  f.write("tasks.md", "# Empty");
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.output, /invalid .spec-state.json/);
  assert.match(result.output, /numbered N.M criteria/);
  assert.match(result.output, /tasks need checkboxes/);
});

test("unresolved choices, unsupported choices and fabricated approval receipts fail", () => {
  for (const change of [
    (s) => { s.decisions[0].answer = null; },
    (s) => { s.decisions[0].answer = "new"; },
    (s) => { s.decisions[0].answer = "invented"; },
    (s) => { s.decisions[0].why = ""; },
    (s) => { s.decisions[0].evidence = ""; },
    (s) => { s.approved = []; },
    (s) => { s.blocking = "Missing evidence"; },
    (s) => { s.decisions.push({ ...s.decisions[0] }); },
  ]) {
    const f = fixture();
    change(f.state); f.save();
    assert.equal(f.run().status, 1);
  }
});

test("existing user choice takes precedence over an auto recommendation", () => {
  const f = fixture();
  Object.assign(f.state.decisions[0], { answer: "new", decided_by: "user", evidence: "User requested a new controller" });
  f.save();
  assert.equal(f.run().status, 0);
});

test("uncovered criteria, orphan citations, empty Verify and unknown command ids fail", () => {
  for (const tasks of [
    (text) => text.replace("1.1, 1.2", "1.1"),
    (text) => text.replace("1.1, 1.2", "1.1, 1.2, 9.9"),
    (text) => text.replace("Verify: retry", "Verify:"),
    (text) => text.replace("Verify: retry", "Verify: imaginary"),
    (text) => text.replace("  Files: `src/search.mjs`, `test/search.test.mjs`\n", ""),
  ]) {
    const f = fixture();
    f.write("tasks.md", tasks(f.tasks));
    assert.equal(f.run().status, 1);
  }
});

test("invalid verification commands and paths fail before execution", () => {
  for (const change of [
    (s) => { s.verification[0].argv = ["npm", "run", "imaginary"]; },
    (s) => { s.verification[0].argv = []; },
    (s) => { s.verification[0].cwd = "../outside"; },
    (s) => { s.verification[0].cwd = "missing-directory"; },
    (s) => { s.verification[0].format = "unknown"; },
    (s) => { s.verification = []; },
  ]) {
    const f = fixture(); change(f.state); f.save();
    assert.equal(f.run().status, 1);
  }
  const f = fixture();
  f.write("tasks.md", f.tasks.replace("src/search.mjs", "../outside.mjs"));
  assert.equal(f.run().status, 1);
});

test("npm verification scripts resolve in the command's working directory", () => {
  const f = fixture();
  mkdirSync(join(f.repo, "package"));
  writeFileSync(join(f.repo, "package/package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  writeFileSync(join(f.repo, "package.json"), "{}");
  f.state.verification[0].cwd = "package"; f.save();
  const result = f.run();
  assert.equal(result.status, 0, result.output);
});

test("each non-regression criterion needs its own test reference", () => {
  const f = fixture();
  f.write("requirements.md", f.requirements.replace("## Out of scope", "1.3 WHEN search succeeds THE SYSTEM SHALL CONTINUE TO show results.\n\n## Out of scope"));
  f.write("tasks.md", f.tasks.replace("1.1, 1.2", "1.1, 1.2, 1.3"));
  assert.match(f.run().output, /criterion 1.3 needs Proven by/);
});

test("unbacked regression test fails and quick specs can omit design", () => {
  const f = fixture();
  f.write("requirements.md", f.requirements.replace("test/search.test.mjs", "test/missing.test.mjs"));
  assert.equal(f.run().status, 1);
  const quickDir = join(f.repo, "quick");
  mkdirSync(quickDir);
  for (const name of ["requirements.md", "tasks.md", ".spec-state.json"]) {
    writeFileSync(join(quickDir, name), name === ".spec-state.json"
      ? JSON.stringify({ ...f.state, type: "quick" })
      : name === "requirements.md" ? f.requirements : f.tasks);
  }
  const result = spawnSync(process.execPath, [validator, quickDir], { cwd: f.repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("completion requires harness evidence even with checked tasks and test files", () => {
  const f = fixture();
  assert.equal(f.run("--complete").status, 1);
  f.state.closure = "implemented"; f.save();
  f.write("tasks.md", f.tasks.replace("[ ]", "[x]"));
  assert.equal(f.run("--complete").status, 1);
  mkdirSync(join(f.repo, "test"));
  writeFileSync(join(f.repo, "test/search.test.mjs"), "// Fixture test file\n");
  const before = readFileSync(join(f.dir, ".spec-state.json"), "utf8");
  const result = f.run("--complete");
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /harness verification receipt/);
  assert.equal(readFileSync(join(f.dir, ".spec-state.json"), "utf8"), before);
});
