import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { afterEach, test } from "node:test";
import { runPr } from "../src/pr.mjs";
import { RUNNERS } from "../src/runners.mjs";
import { assertReceipt, git } from "../skills/spec/scripts/evidence.mjs";
import { fixture } from "./helpers/pr-fixture.mjs";

const originalCwd = process.cwd();
const originalPath = process.env.PATH;
const originalWhich = RUNNERS.codex.which;
const fixtures = [];
function setup() {
  const f = fixture(); fixtures.push(f);
  process.chdir(f.repo);
  process.env.PATH = join(f.root, "bin") + ":" + originalPath;
  RUNNERS.codex.which = () => process.execPath;
  f.start = (run = f.run, raw = "retry") => runPr({ raw, config: { runner: "codex" }, run });
  return f;
}
afterEach(() => {
  process.chdir(originalCwd); process.env.PATH = originalPath; RUNNERS.codex.which = originalWhich;
  for (const f of fixtures.splice(0)) f.cleanup();
});

test("default GitHub probes resolve issues and complete the two-phase draft-PR flow", async () => {
  const f = setup();
  const result = await f.start(f.run, "#12");
  assert.deepEqual(f.calls, ["research", "implementation"]);
  assert.equal(result.url, "https://github.com/acme/app/pull/99");
  const gh = f.ghCalls();
  assert.ok(gh.some((args) => args[0] === "issue" && args.includes("acme/app")));
  const publish = gh.find((args) => args[0] === "pr" && args[1] === "create");
  assert.ok(publish.includes("--draft"));
  assert.ok(gh.some((args) => args.includes("--web")));
  const receipt = JSON.parse(readFileSync(join(dirname(result.closeOut), "verification.json"), "utf8"));
  assert.equal(receipt.commands[0].passed, 2);
  assertReceipt(f.repo, f.latest.specDir, receipt);
  assert.equal(git(f.repo, ["status", "--porcelain"]), "");
  assert.equal(git(f.repo, ["ls-remote", "origin", `refs/heads/${git(f.repo, ["branch", "--show-current"])}`]).split(/\s/)[0], git(f.repo, ["rev-parse", "HEAD"]));
});

test("an old daily close-out cannot make a no-op runner succeed", async () => {
  const f = setup();
  mkdirSync(join(f.repo, ".rusubon/runs"), { recursive: true });
  writeFileSync(join(f.repo, `.rusubon/runs/${new Date().toISOString().slice(0, 10)}-research.md`), "old result");
  await assert.rejects(f.start(() => ({ status: 0 })), /did not write a valid result/);
  assert.ok(!f.ghCalls().some((args) => args[0] === "pr"));
});

test("blocked research closes out with a unique run and no implementation", async () => {
  const f = setup();
  const blocked = async (...args) => {
    await f.run(...args);
    const result = JSON.parse(readFileSync(f.latest.resultPath, "utf8"));
    result.verdict = "requires_human_input"; result.reason = "No reproducible cause";
    writeFileSync(f.latest.resultPath, JSON.stringify(result));
    return { status: 0 };
  };
  const result = await f.start(blocked);
  assert.equal(result.verdict, "requires_human_input");
  assert.deepEqual(f.calls, ["research"]);
  assert.match(readFileSync(result.closeOut, "utf8"), /No reproducible cause/);
  assert.ok(!f.ghCalls().some((args) => args[0] === "pr"));
});

test("invalid specs and early code edits stop before implementation", async () => {
  for (const mutate of [
    (f) => writeFileSync(join(f.latest.specDir, "tasks.md"), "# No tasks"),
    (f) => writeFileSync(join(f.repo, "retry.mjs"), "// premature implementation"),
    (f) => { const p = join(f.latest.specDir, ".spec-state.json"); const s = JSON.parse(readFileSync(p)); s.run_id = "old"; writeFileSync(p, JSON.stringify(s)); },
  ]) {
    const f = setup();
    await assert.rejects(f.start(async (...args) => { await f.run(...args); mutate(f); return { status: 0 }; }));
    assert.deepEqual(f.calls, ["research"]);
    assert.ok(!f.ghCalls().some((args) => args[0] === "pr"));
  }
});

test("changed requirements and undeclared edits never reach publishing", async () => {
  for (const mutate of [
    (f) => { const p = join(f.latest.specDir, "requirements.md"); writeFileSync(p, readFileSync(p, "utf8").replace("allow retry", "disable retry permanently")); },
    (f) => writeFileSync(join(f.repo, "unrelated.txt"), "outside plan"),
    (f) => writeFileSync(join(f.latest.specDir, "unexpected.md"), "added after validation"),
  ]) {
    const f = setup();
    await assert.rejects(f.start(async (...args) => {
      await f.run(...args); if (f.calls.length === 2) mutate(f); return { status: 0 };
    }), /plan changed|undeclared/);
    assert.ok(!f.ghCalls().some((args) => args[0] === "pr"));
  }
});

test("failed, empty and skipped tests do not produce receipts or PRs", async () => {
  for (const testCode of [
    "import {test} from 'node:test'; test('failure',()=>{throw Error('broken')});",
    "// no test cases",
    "import {test} from 'node:test'; test.skip('skipped',()=>{});",
  ]) {
    const f = setup();
    await assert.rejects(f.start(async (...args) => {
      await f.run(...args);
      if (f.calls.length === 2) writeFileSync(join(f.repo, "test/retry.test.mjs"), testCode);
      return { status: 0 };
    }), /verification .* failed|no named test/);
    assert.ok(!existsSync(join(dirname(f.latest.resultPath), "verification.json")));
    assert.ok(!f.ghCalls().some((args) => args[0] === "pr"));
  }
});

test("verification that mutates code is rejected", async () => {
  const f = setup();
  await assert.rejects(f.start(async (...args) => {
    await f.run(...args);
    if (f.calls.length === 2) writeFileSync(join(f.repo, "test/retry.test.mjs"), "import {test} from 'node:test'; import {writeFileSync} from 'node:fs'; test('mutator',()=>writeFileSync('retry.mjs','// modified'));\n");
    return { status: 0 };
  }), /changed the spec or code/);
  assert.ok(!f.ghCalls().some((args) => args[0] === "pr"));
});

test("receipts become invalid after code, spec or log changes", async () => {
  const f = setup();
  const result = await f.start();
  const receipt = JSON.parse(readFileSync(join(dirname(result.closeOut), "verification.json")));
  for (const path of [join(f.repo, "retry.mjs"), join(f.latest.specDir, "requirements.md"), join(f.repo, receipt.commands[0].log)]) {
    const old = readFileSync(path);
    writeFileSync(path, old + "\nchanged\n");
    assert.throws(() => assertReceipt(f.repo, f.latest.specDir, receipt), /does not match|log changed/);
    writeFileSync(path, old);
  }
});

test("runner timeouts and wrong-run results fail even with exit zero", async () => {
  const f = setup();
  await assert.rejects(f.start(() => ({ status: 0, timedOut: true })), /timed out/);
  await assert.rejects(f.start(async (...args) => {
    await f.run(...args);
    const result = JSON.parse(readFileSync(f.latest.resultPath)); result.run_id = "previous";
    writeFileSync(f.latest.resultPath, JSON.stringify(result)); return { status: 0 };
  }), /wrong run/);
});

test("unpublished base commits fail before dispatch", async () => {
  const f = setup();
  writeFileSync(join(f.repo, "unrelated.txt"), "unpublished change");
  git(f.repo, ["add", "unrelated.txt"]); git(f.repo, ["commit", "-m", "unpublished"]);
  await assert.rejects(f.start(), /base branch must match origin/);
  assert.deepEqual(f.calls, []);
});

test("ignored specs cannot produce a PR with a missing plan", async () => {
  const f = setup();
  writeFileSync(join(f.repo, ".gitignore"), readFileSync(join(f.repo, ".gitignore"), "utf8") + "docs/plans/\n");
  git(f.repo, ["add", ".gitignore"]); git(f.repo, ["commit", "-m", "ignore plans"]);
  git(f.repo, ["push", "origin", "main"]);
  await assert.rejects(f.start(), /spec files must not be ignored/);
  assert.deepEqual(f.calls, ["research"]);
  assert.ok(!f.ghCalls().some((args) => args[0] === "pr"));
});

test("post-verification commit hooks cannot publish changed code", async () => {
  const f = setup();
  writeFileSync(join(f.repo, ".git/hooks/pre-commit"), "#!/bin/sh\nprintf 'changed by hook\\n' > retry.mjs\n", { mode: 0o755 });
  await assert.rejects(f.start(), /receipt does not match/);
  assert.ok(!f.ghCalls().some((args) => args[0] === "pr"));
  const branch = git(f.repo, ["branch", "--show-current"]);
  assert.equal(git(f.repo, ["ls-remote", "origin", `refs/heads/${branch}`]), "");
});

test("verified removals keep the same content fingerprint after commit", async () => {
  const f = setup();
  writeFileSync(join(f.repo, "obsolete.txt"), "obsolete");
  git(f.repo, ["add", "obsolete.txt"]); git(f.repo, ["commit", "-m", "fixture file"]);
  git(f.repo, ["push", "origin", "main"]);
  const result = await f.start(async (...args) => {
    await f.run(...args);
    const task = join(f.latest.specDir, "tasks.md");
    if (f.calls.length === 1) writeFileSync(task, readFileSync(task, "utf8").replace("Files:", "Files: `obsolete.txt`,"));
    else renameSync(join(f.repo, "obsolete.txt"), join(f.root, "saved-obsolete.txt"));
    return { status: 0 };
  });
  assert.ok(result.url);
  assert.ok(!git(f.repo, ["ls-files"]).includes("obsolete.txt"));
});
