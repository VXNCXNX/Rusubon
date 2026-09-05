import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { afterEach, test } from "node:test";
import { runPr } from "../src/pr.mjs";
import { RUNNERS, runWith } from "../src/runners.mjs";
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

test("research auxiliary files cannot enter the draft PR", async () => {
  for (const name of ["notes.md", "copied/source.json", "requirements.md.bak"]) {
    const f = setup();
    await assert.rejects(f.start(async (...args) => {
      await f.run(...args);
      if (f.calls.length === 1) {
        const path = join(f.latest.specDir, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "unvalidated research artifact");
      }
      return { status: 0 };
    }), /unexpected spec entry/);
    assert.deepEqual(f.calls, ["research"]);
    assert.equal(git(f.repo, ["branch", "--show-current"]), "main");
    assert.ok(!f.ghCalls().some((args) => args[0] === "pr"));
  }
});

test("ignored research artifacts still fail the spec directory check", async () => {
  const f = setup();
  writeFileSync(join(f.repo, ".git/info/exclude"), "notes.md\n");
  await assert.rejects(f.start(async (...args) => {
    await f.run(...args);
    writeFileSync(join(f.latest.specDir, "notes.md"), "ignored artifact");
    return { status: 0 };
  }), /unexpected spec entry: notes.md/);
  assert.deepEqual(f.calls, ["research"]);
  assert.ok(!f.ghCalls().some((args) => args[0] === "pr"));
});

test("implementation cannot add auxiliary spec files even when a task names them", async () => {
  const f = setup();
  await assert.rejects(f.start(async (...args) => {
    await f.run(...args);
    if (f.calls.length === 1) {
      const path = join(f.latest.specDir, "tasks.md");
      writeFileSync(path, readFileSync(path, "utf8").replace("Files:", `Files: \`${f.latest.specPath}/notes.md\`,`));
    } else writeFileSync(join(f.latest.specDir, "notes.md"), "auxiliary implementation artifact");
    return { status: 0 };
  }), /unexpected spec entry: notes.md/);
  assert.deepEqual(f.calls, ["research", "implementation"]);
  assert.ok(!existsSync(join(dirname(f.latest.resultPath), "verification.json")));
  assert.ok(!f.ghCalls().some((args) => args[0] === "pr"));
});

test("stray and duplicate Files declarations cannot authorize changes", async () => {
  for (const location of ["before", "duplicate", "after heading"]) {
    const f = setup();
    await assert.rejects(f.start(async (...args) => {
      await f.run(...args);
      if (f.calls.length === 1) {
        const path = join(f.latest.specDir, "tasks.md");
        const text = readFileSync(path, "utf8");
        writeFileSync(path, location === "before" ? "Files: `unrelated.txt`\n" + text
          : text + (location === "after heading" ? "\n## Notes\n" : "\n") + "Files: `unrelated.txt`\n");
      } else writeFileSync(join(f.repo, "unrelated.txt"), "outside the task");
      return { status: 0 };
    }), /Files:/);
    assert.deepEqual(f.calls, ["research"]);
    assert.ok(!f.ghCalls().some((args) => args[0] === "pr"));
  }
});

test("ignored task declarations fail before implementation", async () => {
  const f = setup();
  writeFileSync(join(f.repo, ".git/info/exclude"), "local-helper.mjs\n");
  await assert.rejects(f.start(async (...args) => {
    await f.run(...args);
    if (f.calls.length === 1) {
      const path = join(f.latest.specDir, "tasks.md");
      writeFileSync(path, readFileSync(path, "utf8").replace("Files:", "Files: `local-helper.mjs`,"));
    } else writeFileSync(join(f.repo, "local-helper.mjs"), "export const value = true;\n");
    return { status: 0 };
  }), /ignored task files/);
  assert.deepEqual(f.calls, ["research"]);
  assert.ok(!f.ghCalls().some((args) => args[0] === "pr"));
});

test("Git-administrative task paths fail before implementation", async () => {
  for (const name of [".git", ".git/config", ".git/hooks/pre-commit", "nested/.git/config", ".GIT/config"]) {
    const f = setup();
    await assert.rejects(f.start(async (...args) => {
      await f.run(...args);
      if (f.calls.length === 1) {
        const path = join(f.latest.specDir, "tasks.md");
        writeFileSync(path, readFileSync(path, "utf8").replace("Files:", `Files: \`${name}\`,`));
      }
      return { status: 0 };
    }), /Git-administrative task path/);
    assert.deepEqual(f.calls, ["research"]);
    assert.ok(!f.ghCalls().some((args) => args[0] === "pr"));
  }
});

test("implementation cannot make declared files invisible before verification", async () => {
  for (const ignoreFile of [".gitignore", ".git/info/exclude"]) {
    const f = setup();
    await assert.rejects(f.start(async (...args) => {
      await f.run(...args);
      if (f.calls.length === 1) {
        const path = join(f.latest.specDir, "tasks.md");
        writeFileSync(path, readFileSync(path, "utf8").replace("Files:", "Files: `.gitignore`, `local-helper.mjs`,"));
      } else {
        const path = join(f.repo, ignoreFile);
        writeFileSync(path, readFileSync(path, "utf8") + "\nlocal-helper.mjs\n");
        writeFileSync(join(f.repo, "local-helper.mjs"), "export const value = true;\n");
      }
      return { status: 0 };
    }), /ignored task files/);
    assert.deepEqual(f.calls, ["research", "implementation"]);
    assert.ok(!existsSync(join(dirname(f.latest.resultPath), "verification.json")));
    assert.ok(!f.ghCalls().some((args) => args[0] === "pr"));
  }
});

test("tracked task files remain publishable when ignore rules match them", async () => {
  const f = setup();
  writeFileSync(join(f.repo, ".git/info/exclude"), "retry.mjs\n");
  assert.ok((await f.start()).url);
});

test("versionless TAP from an executed verification command can publish", async () => {
  const f = setup();
  const result = await f.start(async (...args) => {
    await f.run(...args);
    if (f.calls.length === 1) {
      const path = join(f.latest.specDir, ".spec-state.json");
      const state = JSON.parse(readFileSync(path));
      state.verification[0].argv = [process.execPath, "--input-type=module", "-e",
        "import assert from 'node:assert/strict'; import {canRetry} from './retry.mjs'; "
        + "assert.equal(canRetry(false,true),true); console.log('ok 1 - retry works\\n1..1');"];
      writeFileSync(path, JSON.stringify(state));
    }
    return { status: 0 };
  });
  assert.ok(result.url);
  const receipt = JSON.parse(readFileSync(join(dirname(result.closeOut), "verification.json")));
  assert.equal(receipt.commands[0].passed, 1);
});

test("hidden worktree edits fail before research without changing index flags", async () => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    const f = setup();
    git(f.repo, ["update-index", flag, "retry.mjs"]);
    writeFileSync(join(f.repo, "retry.mjs"), "export const canRetry = () => true;\n");
    assert.equal(git(f.repo, ["status", "--porcelain"]), "");
    const flags = git(f.repo, ["ls-files", "-v"]);
    await assert.rejects(f.start(), /worktree.*HEAD/);
    assert.deepEqual(f.calls, []);
    assert.equal(git(f.repo, ["ls-files", "-v"]), flags);
    assert.match(readFileSync(join(f.repo, "retry.mjs"), "utf8"), /=> true/);
  }
});

test("clean files with visibility flags do not block a valid PR", async () => {
  const f = setup();
  git(f.repo, ["update-index", "--assume-unchanged", ".gitignore"]);
  assert.ok((await f.start()).url);
  assert.match(git(f.repo, ["ls-files", "-v", ".gitignore"]), /^h /);
});

test("implementation cannot hide uncommitted changes from the publishing gate", async () => {
  const f = setup();
  await assert.rejects(f.start(async (...args) => {
    await f.run(...args);
    if (f.calls.length === 2) git(f.repo, ["update-index", "--assume-unchanged", "retry.mjs"]);
    return { status: 0 };
  }), /worktree.*HEAD/);
  assert.ok(!f.ghCalls().some((args) => args[0] === "pr"));
  assert.equal(git(f.repo, ["ls-remote", "origin", `refs/heads/${git(f.repo, ["branch", "--show-current"])}`]), "");
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

test("failed and skipped tests do not produce receipts or PRs", async () => {
  for (const testCode of [
    "import {test} from 'node:test'; test('failure',()=>{throw Error('broken')});",
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

test("real tests named after existing files and directories can publish", async () => {
  for (const name of ["retry.mjs", "test", "test/retry.test.mjs"]) {
    const f = setup();
    const result = await f.start(async (...args) => {
      await f.run(...args);
      if (f.calls.length === 2) writeFileSync(join(f.repo, "test/retry.test.mjs"),
        "import {test} from 'node:test'; import assert from 'node:assert/strict';\n"
        + "import {canRetry} from '../retry.mjs';\n"
        + `test(${JSON.stringify(name)},()=>assert.equal(canRetry(false,true),true));\n`);
      return { status: 0 };
    });
    assert.ok(result.url);
    const receipt = JSON.parse(readFileSync(join(dirname(result.closeOut), "verification.json")));
    assert.equal(receipt.commands[0].passed, 1, name);
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

test("exit-zero commands with invalid TAP cannot issue receipts or publish", async () => {
  for (const tap of ["TAP version 13\nok 1 - only\n1..2\n", "TAP version 13\n1..0\nok 1 - unexpected\n", "TAP version 13\n1..0\n"]) {
    const f = setup();
    await assert.rejects(f.start(async (...args) => {
      await f.run(...args);
      if (f.calls.length === 1) {
        const path = join(f.latest.specDir, ".spec-state.json");
        const state = JSON.parse(readFileSync(path));
        state.verification[0].argv = [process.execPath, "-e", `process.stdout.write(${JSON.stringify(tap)})`];
        writeFileSync(path, JSON.stringify(state));
      }
      return { status: 0 };
    }), /did not produce passing TAP|no named test/);
    assert.ok(!existsSync(join(dirname(f.latest.resultPath), "verification.json")));
    assert.ok(!f.ghCalls().some((args) => args[0] === "pr"));
  }
});

test("repositories with a clean initialized submodule complete the PR flow", async () => {
  const f = setup();
  git(f.repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-b", "main", join(f.root, "remote.git"), "dependency"]);
  git(f.repo, ["commit", "-am", "add dependency"]);
  git(f.repo, ["push", "origin", "main"]);
  assert.ok((await f.start()).url);
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

test("a real runner timeout writes a failure close-out and never publishes", async () => {
  const f = setup();
  writeFileSync(join(f.root, "bin/codex"), `#!${process.execPath}\n`
    + "process.on('SIGTERM', () => {});\nsetTimeout(() => process.exit(0), 2000);\n", { mode: 0o755 });
  await assert.rejects(f.start((runner, prompt, options) => runWith(runner, prompt,
    { ...options, timeoutMs: 500 })), /research runner timed out/);
  const runs = join(f.repo, ".rusubon/runs");
  const [runId] = readdirSync(runs);
  assert.match(readFileSync(join(runs, runId, "close-out.md"), "utf8"),
    /Verdict: requires_human_input[\s\S]*research runner timed out/);
  assert.ok(!f.ghCalls().some((args) => args[0] === "pr"));
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

test("Git hooks cannot replace the validated PR body with run artifact contents", async () => {
  for (const hook of ["pre-commit", "post-commit", "pre-push"]) {
    const f = setup();
    writeFileSync(join(f.repo, `.git/hooks/${hook}`),
      "#!/bin/sh\nfor body in .rusubon/runs/*/pr-body.md; do printf 'unvalidated hook text' > \"$body\"; done\n", { mode: 0o755 });
    const result = await f.start();
    assert.ok(result.url);
    assert.equal(readFileSync(join(dirname(result.closeOut), "pr-body.md"), "utf8"), "unvalidated hook text");
    const body = readFileSync(f.publishedBody, "utf8");
    assert.match(body, /Failed searches prevent retry/);
    assert.match(body, /## Harness verification/);
    assert.ok(body.includes(result.specPath));
    assert.ok(!body.includes("unvalidated hook text"));
  }
});

test("staged and hook-added run artifacts cannot enter a published commit", async () => {
  for (const phase of ["implementation", "commit hook"]) {
    const f = setup();
    if (phase === "commit hook") writeFileSync(join(f.repo, ".git/hooks/pre-commit"),
      "#!/bin/sh\nmkdir -p .rusubon/runs\nprintf private > .rusubon/runs/private.md\ngit add -f -- .rusubon/runs/private.md\n", { mode: 0o755 });
    await assert.rejects(f.start(async (...args) => {
      await f.run(...args);
      if (phase === "implementation" && f.calls.length === 2) {
        writeFileSync(join(f.repo, ".rusubon/runs/private.md"), "private");
        git(f.repo, ["add", "-f", "--", ".rusubon/runs/private.md"]);
      }
      return { status: 0 };
    }), /paths differ from verified files/);
    assert.ok(!f.ghCalls().some((args) => args[0] === "pr"));
    assert.equal(git(f.repo, ["ls-remote", "origin", `refs/heads/${git(f.repo, ["branch", "--show-current"])}`]), "");
  }
});

test("quoted comma paths and literal Git filenames survive through publishing", async () => {
  for (const format of ["code spans", "JSON"]) {
    const f = setup();
    const names = ["data,legacy.mjs", "name[1]*.mjs", ":(glob)*", "a`b.mjs"];
    const result = await f.start(async (...args) => {
      await f.run(...args);
      if (f.calls.length === 1) {
        const path = join(f.latest.specDir, "tasks.md");
        const files = ["retry.mjs", "test/retry.test.mjs", ...names];
        const value = format === "JSON" ? JSON.stringify(files)
          : files.map((name) => name.includes("`") ? "``" + name + "``" : "`" + name + "`").join(", ");
        writeFileSync(path, readFileSync(path, "utf8").replace(/^Files:.*$/m, `Files: ${value}`));
      } else for (const name of names) writeFileSync(join(f.repo, name), "declared content");
      return { status: 0 };
    });
    assert.ok(result.url);
    const committed = git(f.repo, ["ls-tree", "-r", "--name-only", "-z", "HEAD"]).split("\0");
    for (const name of names) assert.ok(committed.includes(name), name);
  }
});

test("Git normalization may omit a verified edit while publishing the product fix", async () => {
  const f = setup();
  writeFileSync(join(f.repo, ".gitattributes"), "line-ending.txt text eol=crlf\n");
  writeFileSync(join(f.repo, "line-ending.txt"), "same content\r\n");
  git(f.repo, ["add", ".gitattributes", "line-ending.txt"]);
  git(f.repo, ["commit", "-m", "fixture line endings"]);
  git(f.repo, ["push", "origin", "main"]);
  const result = await f.start(async (...args) => {
    await f.run(...args);
    if (f.calls.length === 1) {
      const task = join(f.latest.specDir, "tasks.md");
      writeFileSync(task, readFileSync(task, "utf8").replace("Files:", "Files: `line-ending.txt`,"));
    } else writeFileSync(join(f.repo, "line-ending.txt"), "same content\n");
    return { status: 0 };
  });
  assert.ok(result.url);
  assert.ok(!git(f.repo, ["diff", "--name-only", "HEAD^", "HEAD"]).includes("line-ending.txt"));
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
