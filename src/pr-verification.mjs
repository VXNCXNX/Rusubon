import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { assertReceipt, hash, localPath, planHash, snapshot } from "../skills/spec/scripts/evidence.mjs";
import { skillsDir } from "./run.mjs";
import { redact } from "./doctor.mjs";

export function validateSpec(repo, specDir, receiptPath) {
  const args = [join(skillsDir(), "spec/scripts/check-spec.mjs"), specDir];
  if (receiptPath) args.push("--complete", "--receipt", receiptPath);
  const result = spawnSync(process.execPath, args, { cwd: repo, encoding: "utf8", timeout: 30000 });
  if (result.status !== 0) throw new Error(`spec validation failed: ${result.stdout || ""}${result.stderr || result.error?.message || ""}`);
}

export function passingTap(output, cwd) {
  if (!/^TAP version \d+\s*$/m.test(output) || !/^\s*1\.\.\d+/m.test(output)
      || /^\s*Bail out!/im.test(output) || /^# (?:fail|cancelled) [1-9]/m.test(output)
      || /^\s*not ok\b(?![^\n]*# (?:SKIP|TODO)\b)/im.test(output)) {
    throw new Error("test command did not produce passing TAP");
  }
  const cases = [...output.matchAll(/^([ \t]*)ok\s+\d+\s+-\s+([^\n]+)\n([^]*?)(?=^[ \t]*(?:not )?ok\s+\d+\b|$(?![^]))/gm)];
  const passed = cases.filter(([, , name, details]) => !/# (?:SKIP|TODO)\b/i.test(name)
    && !/type: ['"]?suite['"]?/.test(details.split("...")[0])
    // Node treats an empty test file as one passing file subtest. It is not a test case.
    && !existsSync(resolve(cwd, name.trim()))).length;
  if (!passed) throw new Error("test command passed no named test cases (empty files and skipped tests do not count)");
  return passed;
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
    const passed = command.kind === "test" ? passingTap(result.stdout, working) : undefined;
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
