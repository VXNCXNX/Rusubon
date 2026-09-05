import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Parser } from "tap-parser";
import { assertReceipt, hash, localPath, planHash, snapshot } from "../skills/spec/scripts/evidence.mjs";
import { parseTasks } from "../skills/spec/scripts/tasks.mjs";
import { assertPublishableTaskPaths } from "./pr-task-paths.mjs";
import { skillsDir } from "./run.mjs";
import { redact } from "./doctor.mjs";

export function validateSpec(repo, specDir, receiptPath) {
  const args = [join(skillsDir(), "spec/scripts/check-spec.mjs"), specDir];
  if (receiptPath) args.push("--complete", "--receipt", receiptPath);
  const result = spawnSync(process.execPath, args, { cwd: repo, encoding: "utf8", timeout: 30000 });
  if (result.status !== 0) throw new Error(`spec validation failed: ${result.stdout || ""}${result.stderr || result.error?.message || ""}`);
  const { tasks } = parseTasks(readFileSync(join(specDir, "tasks.md"), "utf8"));
  assertPublishableTaskPaths(repo, tasks.flatMap((task) => task.files));
}

export function passingTap(output) {
  // npm may print its script banner before the TAP stream starts.
  // Version headers are optional. Preserve comments, nested tests and failures
  // from the first protocol line instead of seeking a later successful header.
  const start = output.search(/^[ \t]*(?:TAP version\b|(?:not )?ok\b|\d+\.\.|Bail out!|#|pragma\b)/im);
  const parser = new Parser({ strict: true });
  let extra = false;
  function countCases(stream) {
    const counts = { passed: 0 };
    let child;
    stream.on("extra", () => { extra = true; });
    stream.on("child", (nested) => { child = countCases(nested); });
    stream.on("assert", (result) => {
      const nested = child; child = undefined;
      if (!result.ok || result.skip || result.todo) return;
      // A closing test point contributes its children, never an extra case.
      // This also handles anonymous subtests whose closing name differs.
      counts.passed += nested ? nested.passed : Number(Boolean(result.name.trim()) && result.diag?.type !== "suite");
    });
    return counts;
  }
  const counts = countCases(parser);
  if (start >= 0) parser.end(output.slice(start));
  if (start < 0 || extra || !parser.results?.ok || parser.results.bailout
      || /^# (?:fail|cancelled) [1-9]/m.test(output)) {
    throw new Error("test command did not produce passing TAP");
  }
  if (!counts.passed) throw new Error("test command passed no named test cases (zero-case plans, suites and skipped tests do not count)");
  return counts.passed;
}

export function verifyImplementation({ repo, specDir, runDir, runId, source }) {
  validateSpec(repo, specDir);
  const state = JSON.parse(readFileSync(join(specDir, ".spec-state.json"), "utf8"));
  if (state.closure !== "implemented") throw new Error("implementation did not complete the spec");
  const tree = snapshot(repo).digest;
  const plan = planHash(specDir);
  const commands = [];
  for (const command of state.verification) {
    const working = localPath(repo, command.cwd);
    const [bin, ...args] = command.argv;
    const env = { ...process.env, CI: "1", FORCE_COLOR: "0" };
    // A nested Node test runner otherwise emits its parent's binary IPC format.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(bin, args, {
      cwd: working, encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024,
      env,
    });
    const output = redact(`${result.stdout || ""}${result.stderr || ""}`);
    const log = join(runDir, `${command.id}.log`);
    writeFileSync(log, output);
    if (result.status !== 0 || result.error || result.signal) {
      throw new Error(`verification ${command.id} failed (${result.error?.code || result.signal || result.status}); see ${log}`);
    }
    const passed = command.kind === "test" ? passingTap(result.stdout) : undefined;
    commands.push({ id: command.id, argv: command.argv, cwd: command.cwd, kind: command.kind,
      exit_code: result.status, passed, log: relative(repo, log), log_hash: hash(output) });
    if (snapshot(repo).digest !== tree || planHash(specDir) !== plan) {
      throw new Error(`verification ${command.id} changed the spec or code; re-plan and verify the new content`);
    }
  }
  const receipt = { version: 1, run_id: runId, source, plan_hash: plan, tree_hash: tree,
    verified_at: new Date().toISOString(), commands };
  assertReceipt(repo, specDir, receipt);
  const receiptPath = join(runDir, "verification.json");
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  validateSpec(repo, specDir, receiptPath);
  return receipt;
}
