import { randomUUID } from "node:crypto";
import { spawnBoundedSync as spawnSync } from "../skills/spec/scripts/process.mjs";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { assertPrReady, defaultProbes, redact } from "./doctor.mjs";
import { cwd, runsDir } from "./paths.mjs";
import { formatIssueRef, parseSource, resolveSource } from "./pr-source.mjs";
import { buildPrPrompt } from "./pr-prompt.mjs";
import { runWith } from "./runners.mjs";
import { validateSpec, verifyImplementation } from "./pr-verification.mjs";
import { assertReceipt, assertWorktreeMatchesHead, changedFiles, git, localPath, planHash, snapshot, specFiles } from "../skills/spec/scripts/evidence.mjs";
import { parseTasks } from "../skills/spec/scripts/tasks.mjs";

export { buildPrPrompt } from "./pr-prompt.mjs";

/** Read a phase result, sanitize stored credentials, and validate its run identity. */
function readResult(path, runId, source, phase) {
  let raw;
  try { raw = readFileSync(path, "utf8"); }
  catch { throw new Error(`${phase} did not write a valid result for this run`); }
  let result, original, sanitized;
  try {
    result = JSON.parse(raw);
    original = JSON.stringify(result);
    sanitized = JSON.stringify(result, (_key, value) => {
      if (typeof value === "string") return redact(value);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redact(key), entry]));
      }
      return value;
    });
  } catch {
    // Invalid JSON cannot be safely inspected, so retain only a diagnostic.
    writeFileSync(path, JSON.stringify({ error: "invalid phase result" }) + "\n");
    throw new Error(`${phase} did not write a valid result for this run`);
  }
  if (sanitized !== original) {
    writeFileSync(path, sanitized + "\n");
    throw new Error(`${phase} result contained credentials; sanitized the artifact and stopped the run`);
  }
  if (result?.run_id !== runId || result.source !== source || result.phase !== phase
      || !["immediately_actionable", "requires_human_input", "not_actionable"].includes(result.verdict)
      || typeof result.reason !== "string" || !result.reason.trim()) {
    throw new Error(`${phase} result has wrong run/source/phase or missing verdict/reason`);
  }
  return result;
}

/** Reject runner changes to the expected revision or branch. */
function assertHead(repo, head, branch) {
  if (git(repo, ["rev-parse", "HEAD"]) !== head || git(repo, ["branch", "--show-current"]) !== branch) {
    throw new Error("runner changed the Git revision or branch; refusing to publish");
  }
}

/** Run a GitHub CLI operation with optional stdin in the checkout and throw on failure. */
function gh(repo, args, input) {
  const result = spawnSync("gh", args, { cwd: repo, input, encoding: "utf8", timeout: 120000, killSignal: "SIGKILL" });
  if (result.status !== 0) throw new Error(`gh ${args[0]} failed: ${result.stderr || result.error?.message || result.status}`);
  return result.stdout.trim();
}

/** Return sorted literal paths in a Git delta, counting renames as removal and addition. */
function changedGitPaths(repo, diffArgs) {
  return git(repo, ["diff", "--no-renames", "--name-only", "-z", ...diffArgs, "--"])
    .split("\0").filter(Boolean).sort();
}

/** Commit verified files and create a draft PR after rechecking scope and content.
 * Throws before the next publication step if hooks change the expected evidence. */
function publish({ repo, specDir, runDir, receipt, result, branch, base, files }) {
  if (typeof result.pr_title !== "string" || !/^(fix|feat|refactor|test|docs|chore)(\([^)\n]+\))?: [^\n]+$/.test(result.pr_title)
      || typeof result.pr_body !== "string" || !/^## Agent context\s*$/im.test(result.pr_body)
      || !result.pr_body.includes(relative(repo, specDir))) {
    throw new Error("implementation needs a Conventional Commit pr_title and pr_body with Agent context and the spec path");
  }
  assertReceipt(repo, specDir, receipt);
  const bodyFile = join(runDir, "pr-body.md");
  if (redact(result.pr_body) !== result.pr_body || redact(result.pr_title) !== result.pr_title) {
    throw new Error("PR text contains a credential; refusing to publish");
  }
  const body = `${result.pr_body.trim()}\n\n## Harness verification\n\n`
    + receipt.commands.map((command) => `- ${command.id}: exit 0${command.passed ? `, ${command.passed} passing TAP cases` : ""}.`).join("\n")
    + `\n\nSpec hash: \`${receipt.plan_hash}\`. Code content hash: \`${receipt.tree_hash}\`.\n`;
  writeFileSync(bodyFile, body);
  const parent = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["--literal-pathspecs", "add", "--", ...files]);
  const staged = changedGitPaths(repo, ["--cached", parent]);
  // Git content filters can normalize a verified edit back to its base content.
  if (staged.some((path) => !files.includes(path))) {
    throw new Error("staged paths differ from verified files; refusing to publish");
  }
  if (!staged.some((path) => !path.startsWith(`${relative(repo, specDir)}/`))) {
    throw new Error("implementation made no product change after Git normalization");
  }
  git(repo, ["commit", "-m", result.pr_title]);
  const commit = git(repo, ["rev-parse", "HEAD"]);
  if (git(repo, ["rev-list", "--parents", "-n", "1", commit]) !== `${commit} ${parent}`) {
    throw new Error("commit ancestry changed during publishing");
  }
  if (JSON.stringify(changedGitPaths(repo, [parent, commit])) !== JSON.stringify(staged)) {
    throw new Error("committed paths differ from verified files; refusing to publish");
  }
  // Hooks or another writer may change content during the commit.
  assertReceipt(repo, specDir, receipt);
  assertWorktreeMatchesHead(repo);
  if (git(repo, ["branch", "--show-current"]) !== branch) throw new Error("branch changed before push");
  git(repo, ["push", "--set-upstream", "origin", `${commit}:refs/heads/${branch}`]);
  assertHead(repo, commit, branch);
  assertReceipt(repo, specDir, receipt);
  assertWorktreeMatchesHead(repo);
  // Publish the validated in-memory body; hooks may change its on-disk copy.
  const url = gh(repo, ["pr", "create", "--draft", "--base", base, "--head", branch,
    "--title", result.pr_title, "--body-file", "-"], body);
  // Opening the review is best effort on hosts without a browser.
  try { gh(repo, ["pr", "view", url, "--web"]); }
  catch { console.log(`open for review: ${url}`); }
  return url;
}

/** Run human-launched research, spec validation, implementation and draft publication.
 * Returns run metadata and a verdict; workflow failures preserve files and write a close-out. */
export async function runPr({ raw, flags, config, probes = defaultProbes(), run = runWith }) {
  assertPrReady(config, probes);
  const source = resolveSource(parseSource(raw, flags), probes);
  const label = source.kind === "issue" ? formatIssueRef(source) : source.slug;
  const repo = cwd();
  if (realpathSync(repo) !== realpathSync(git(repo, ["rev-parse", "--show-toplevel"]))) {
    throw new Error("run rusubon pr from the Git checkout root");
  }
  if (git(repo, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"])) throw new Error("rusubon pr needs a clean checkout; keep existing changes in a separate worktree or commit them first");
  assertWorktreeMatchesHead(repo);
  const base = git(repo, ["branch", "--show-current"]);
  if (!base) throw new Error("rusubon pr needs a named base branch");
  const head = git(repo, ["rev-parse", "HEAD"]);
  const remoteHead = git(repo, ["ls-remote", "--exit-code", "origin", `refs/heads/${base}`]).split(/\s/)[0];
  if (remoteHead !== head) throw new Error("base branch must match origin before rusubon pr; unpublished base commits would enter the PR");
  const before = snapshot(repo);
  const runId = randomUUID();
  mkdirSync(runsDir(), { recursive: true });
  const runDir = join(runsDir(), runId);
  mkdirSync(runDir);
  // Keep date/UUID spec names and branch components below filesystem limits.
  // The full source stays in results; the run UUID keeps shortened names unique.
  const slug = (source.kind === "issue" ? `issue-${source.number}` : source.slug).slice(0, 160);
  const specPath = `docs/plans/${new Date().toISOString().slice(0, 10)}-${slug}-${runId}`;
  const specDir = localPath(repo, specPath);
  const closeOut = join(runDir, "close-out.md");
  /** Write the redacted close-out and return the run outcome. */
  const finish = (verdict, reason, url) => {
    writeFileSync(closeOut, redact(`# Research ${label}\n\nRun: ${runId}\nVerdict: ${verdict}\n\n${reason}\n\nSpec: ${specPath}\n${url ? `\nDraft PR: ${url}\n` : ""}`));
    console.log(`close-out ${relative(repo, closeOut)}`);
    return { runId, verdict, closeOut, specPath, url };
  };
  /** Dispatch one runner phase and require a result belonging to this run. */
  const phase = async (name) => {
    const prompt = buildPrPrompt(source, config, { phase: name, runId, runDir: relative(repo, runDir), specPath });
    writeFileSync(join(runDir, `${name}-prompt.md`), prompt);
    console.log(`${name}  ${label}  run=${runId}`);
    let result, parsed, resultError;
    try {
      result = await run(config.runner, prompt, { phase: name, timeoutMs: 30 * 60 * 1000 });
    } finally {
      // Failed or interrupted runners may still have written sensitive artifacts.
      try { parsed = readResult(join(runDir, `${name}.json`), runId, label, name); }
      catch (error) { resultError = error; }
    }
    if (result.status !== 0 || result.timedOut) throw new Error(`${name} runner ${result.timedOut ? "timed out" : `exited ${result.status}`}`);
    if (resultError) throw resultError;
    return parsed;
  };
  try {
    const research = await phase("research");
    assertHead(repo, head, base);
    const planned = snapshot(repo);
    const outsidePlan = changedFiles(before, planned).filter((path) => !path.startsWith(`${specPath}/`));
    if (outsidePlan.length) throw new Error(`research modified files before the spec gate: ${outsidePlan.join(", ")}`);
    if (research.verdict !== "immediately_actionable") return finish(research.verdict, research.reason);
    validateSpec(repo, specDir);
    const state = JSON.parse(readFileSync(join(specDir, ".spec-state.json"), "utf8"));
    for (const name of specFiles(state.type)) {
      if (!Object.hasOwn(planned.files, `${specPath}/${name}`)) throw new Error("spec files must not be ignored; the draft PR must include the validated plan");
    }
    if (state.run_id !== runId || state.source !== label || state.closure !== undefined
        || /^\s*-\s*\[[xX]\]/m.test(readFileSync(join(specDir, "tasks.md"), "utf8"))) {
      throw new Error("research spec has stale source, run id or completed tasks");
    }
    const plan = planHash(specDir);
    const { tasks, problems } = parseTasks(readFileSync(join(specDir, "tasks.md"), "utf8"));
    if (problems.length) throw new Error(`invalid task declarations: ${problems.join("; ")}`);
    const allowed = new Set(tasks.flatMap((task) => task.files.map((path) => relative(repo, localPath(repo, path)))));
    allowed.add(`${specPath}/tasks.md`);
    allowed.add(`${specPath}/.spec-state.json`);
    const branch = `codex/rusubon-${slug}-${runId}`;
    git(repo, ["switch", "-c", branch]);
    const implementation = await phase("implementation");
    assertHead(repo, head, branch);
    if (implementation.verdict !== "immediately_actionable") return finish(implementation.verdict, implementation.reason);
    if (planHash(specDir) !== plan) throw new Error("validated plan changed during implementation; a fresh research pass is required");
    const implemented = snapshot(repo);
    const files = changedFiles(before, implemented);
    const outsideScope = changedFiles(planned, implemented).filter((path) => !allowed.has(path));
    if (outsideScope.length) throw new Error(`implementation changed undeclared files: ${outsideScope.join(", ")}`);
    if (!files.some((path) => !path.startsWith(`${specPath}/`))) throw new Error("implementation made no product change");
    const receipt = verifyImplementation({ repo, specDir, runDir, runId, source: label });
    assertHead(repo, head, branch);
    const url = publish({ repo, specDir, runDir, receipt, result: implementation, branch, base, files });
    return finish("immediately_actionable", implementation.reason, url);
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : error);
    finish("requires_human_input", message);
    throw new Error(message);
  }
}
