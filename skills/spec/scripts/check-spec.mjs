#!/usr/bin/env node
// Auto-mode adaptation of VXNCXNX/spec-skill. See ../LICENSE.
// Read-only validation. Never executes commands found in a spec.
import { existsSync, readFileSync, readdirSync, statSync, lstatSync, realpathSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { assertReceipt, localPath, specFiles } from "./evidence.mjs";
import { parseTasks } from "./tasks.mjs";

const [specDir, ...flags] = process.argv.slice(2);
const receiptIndex = flags.indexOf("--receipt");
const receiptPath = receiptIndex >= 0 ? flags[receiptIndex + 1] : undefined;
const options = receiptIndex >= 0 ? flags.filter((_, i) => i !== receiptIndex && i !== receiptIndex + 1) : flags;
if (!specDir || options.some((flag) => flag !== "--complete") || (receiptIndex >= 0 && !receiptPath)) {
  console.error("usage: check-spec.mjs <spec-dir> [--complete --receipt <path>]");
  process.exit(2);
}
const complete = flags.includes("--complete");
function blocks(text, pattern) {
  const starts = [...text.matchAll(pattern)];
  return starts.map((match, index) => [
    match[1], text.slice(match.index + match[0].length, starts[index + 1]?.index ?? text.length),
  ]);
}
const problems = [];
const fail = (message) => problems.push(message);
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const isFile = (path) => existsSync(path) && statSync(path).isFile();
const read = (name) => {
  try {
    const full = join(resolve(specDir), name);
    if (!lstatSync(full).isFile()) throw new Error("expected a regular file");
    // macOS may spell the same temporary checkout as /var or /private/var.
    const path = localPath(process.cwd(), relative(realpathSync(process.cwd()), realpathSync(full)));
    return readFileSync(path, "utf8");
  } catch {
    fail(`missing or unreadable ${name}`);
    return "";
  }
};

let state = {};
try {
  state = JSON.parse(read(".spec-state.json"));
  if (!state || Array.isArray(state) || typeof state !== "object") throw new Error("expected an object");
} catch (error) {
  fail(`invalid .spec-state.json: ${error.message}`);
  state = {};
}
if (state.mode !== "auto") fail("mode must be auto");
if (!["quick", "bug", "feature"].includes(state.type)) fail("type must be quick, bug or feature");
try {
  const expected = new Set(specFiles(state.type));
  for (const name of readdirSync(resolve(specDir))) {
    if (!expected.has(name)) fail(`unexpected spec entry: ${name}`);
  }
} catch (error) {
  fail(`cannot read spec directory: ${error.message}`);
}
if (![1, 2, 3].includes(state.tier)) fail("tier must be 1, 2 or 3");
for (const field of ["source", "risk_reason", "run_id"]) {
  if (!nonempty(state[field])) fail(`${field} is required`);
}
if (state.approved !== undefined) fail("auto mode records decisions, not approved receipts");
if (state.blocking !== undefined && state.blocking !== null && state.blocking !== "") fail("spec has an unresolved blocker");
if (state.closure !== undefined && state.closure !== "implemented") fail("this flow only records closure implemented");
if (complete && state.closure !== "implemented") fail("complete spec needs closure implemented");
if (complete && !receiptPath) fail("complete spec needs a harness verification receipt");

const verification = Array.isArray(state.verification) ? state.verification : [];
const checks = new Map();
if (!verification.some((command) => command?.kind === "test")) fail("verification needs at least one test command");
for (const command of verification) {
  if (!command || !/^[a-z0-9][a-z0-9-]*$/.test(command.id || "") || checks.has(command.id)) {
    fail("verification command needs a unique lowercase id");
    continue;
  }
  checks.set(command.id, command);
  if (!["test", "check"].includes(command.kind)) fail(`invalid verification kind for ${command.id}`);
  if (command.kind === "test" && command.format !== "tap") fail(`test ${command.id} must emit TAP`);
  if (!Array.isArray(command.argv) || !command.argv.length || !command.argv.every(nonempty)) fail(`invalid argv for ${command.id}`);
  try {
    const working = localPath(process.cwd(), command.cwd);
    if (!existsSync(working) || !statSync(working).isDirectory()) throw new Error("missing working directory");
    const [bin, action, name] = command.argv || [];
    if (bin === "npm" && ["test", "run", "run-script"].includes(action)) {
      const script = action === "test" ? "test" : name;
      const scripts = JSON.parse(readFileSync(join(working, "package.json"), "utf8")).scripts || {};
      if (!Object.hasOwn(scripts, script)) throw new Error(`missing npm script ${script}`);
    }
  } catch (error) { fail(`${command.id}: ${error.message}`); }
}

const decisions = Array.isArray(state.decisions) ? state.decisions : [];
if (!Array.isArray(state.decisions)) fail("decisions must be an array");
const ids = new Set();
for (const decision of decisions) {
  if (!decision || typeof decision !== "object") {
    fail("invalid decision");
    continue;
  }
  for (const field of ["id", "title", "recommended", "answer", "why", "evidence"]) {
    if (!nonempty(decision[field])) fail(`decision ${decision.id || "?"} needs ${field}`);
  }
  if (ids.has(decision.id)) fail(`duplicate decision id ${decision.id}`);
  ids.add(decision.id);
  if (!Array.isArray(decision.options) || !decision.options.every(nonempty)
      || !decision.options.includes(decision.recommended) || !decision.options.includes(decision.answer)) {
    fail(`decision ${decision.id} must select from its options`);
  }
  if (!["auto", "user"].includes(decision.decided_by)) fail(`decision ${decision.id} needs decided_by auto or user`);
  if (decision.decided_by === "auto" && decision.answer !== decision.recommended) {
    fail(`auto decision ${decision.id} must select its recommendation`);
  }
}
for (const decision of decisions) {
  if (decision?.superseded_by !== undefined
      && (!ids.has(decision.superseded_by) || decision.superseded_by === decision.id)) {
    fail(`decision ${decision.id} has an invalid replacement`);
  }
}

const requirements = read("requirements.md");
if (state.type !== "quick" && !read("design.md").trim()) fail("design must not be empty");
if (!/^##\s+Out of scope\s*$/im.test(requirements)) fail("requirements need Out of scope");
const criteria = new Set();
const criterionBlocks = blocks(requirements, /^[ \t]*(?:[-*][ \t]*)?(\d+\.\d+)[.)]?[ \t]+/gm)
  .map(([id, body]) => [id, body.split(/^#{1,6}\s/m)[0]]);
for (const [id] of criterionBlocks) {
  if (criteria.has(id)) fail(`duplicate criterion ${id}`);
  criteria.add(id);
}
if (!criteria.size) fail("requirements need numbered N.M criteria");

const taskText = read("tasks.md");
const { tasks, problems: taskProblems } = parseTasks(taskText);
taskProblems.forEach(fail);
if (!tasks.length) fail("tasks need checkboxes");
const cited = new Set();
const files = new Set();
for (const [index, { checked, block, files: declared }] of tasks.entries()) {
  const label = `task ${index + 1}`;
  if ((complete || state.closure === "implemented") && checked === " ") fail(`${label} is incomplete`);
  for (const name of declared) {
    try { localPath(process.cwd(), name); files.add(name); }
    catch (error) { fail(`${label}: ${error.message}`); }
  }
  const verify = block.match(/^[ \t]*(?:[-*][ \t]*)?Verify:[ \t]*(\S[^\n]*)/m);
  if (!verify) fail(`${label} needs Verify:`);
  else for (const id of verify[1].replaceAll("`", "").split(",").map((value) => value.trim())) {
    if (!checks.has(id)) fail(`${label} refers to unknown verification ${id}`);
  }
  const refs = block.match(/_Requirements:\s*([^_]+)_/);
  if (!refs) fail(`${label} needs _Requirements:_`);
  else for (const id of refs[1].split(",").map((value) => value.trim())) {
    if (id !== "enabler") cited.add(id);
  }
}
for (const id of criteria) if (!cited.has(id)) fail(`criterion ${id} has no task`);
for (const id of cited) if (!criteria.has(id)) fail(`task cites unknown criterion ${id}`);

let assertions = 0;
for (const [id, body] of criterionBlocks) {
  if (!/SHALL\s+CONTINUE\s+TO/.test(body)) continue;
  assertions++;
  const proof = body.match(/Proven by:[ \t]*`?([^`\n]+)`?[ \t]*$/m)?.[1]?.trim();
  if (!proof) fail(`non-regression criterion ${id} needs Proven by:`);
  else {
    try {
      const path = localPath(process.cwd(), proof);
      if (!isFile(path) && (complete || state.closure === "implemented" || !files.has(proof))) {
        fail(`non-regression test ${proof} must exist${complete ? "" : " or be created by a task"}`);
      }
    } catch (error) { fail(error.message); }
  }
}
if ((state.type === "bug" || state.tier === 3) && !assertions) fail("bugs and tier 3 need non-regression criteria");
if (complete && receiptPath && !problems.length) {
  try { assertReceipt(process.cwd(), resolve(specDir), JSON.parse(readFileSync(receiptPath, "utf8"))); }
  catch (error) { fail(error.message); }
}

console.log(`spec ${specDir}: ${criteria.size} criteria, ${tasks.length} tasks, ${decisions.length} decisions`);
for (const problem of problems) console.error(`fail: ${problem}`);
console.log(problems.length ? `${problems.length} problem(s)` : "clean");
process.exitCode = problems.length ? 1 : 0;
