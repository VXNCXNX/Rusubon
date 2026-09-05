import { randomUUID } from "node:crypto";
import { initConfig, loadConfig } from "../config.mjs";
import { MEMORY_PREFIXES } from "../paths.mjs";
import { defaultProbes } from "../doctor.mjs";
import { decline } from "../decline.mjs";
import { draftContext } from "../context-draft.mjs";
import { runSkill } from "../run.mjs";
import { runPr } from "../pr.mjs";
import { inspectClaude, runClaude } from "./claude.mjs";
import { inspectCodex, runCodex } from "./codex.mjs";
import { validateSelection } from "./models.mjs";
import { mustCommand, safeText } from "./process.mjs";
import { assertSetupRevision, localPath, reportDetail, saveSetup, writeLocal } from "./workspace.mjs";
import { preparePr } from "./pr-worktree.mjs";

const controller = new AbortController(), requests = new Map();
const supervisorPid = process.ppid;
const send = message => { if (process.connected) process.send(message); };
const emit = event => send({ type: "event", event });
const inspect = (runner, cwd) => runner === "claude" ? inspectClaude(cwd) : inspectCodex(cwd);

function ask(request, signal = controller.signal) {
  if (signal.aborted || !process.connected) return Promise.resolve({ allow: false });
  return new Promise(resolve => {
    const id = randomUUID();
    const close = response => { requests.delete(id); signal.removeEventListener("abort", abort); send({ type: "request_closed", id }); resolve(response); };
    const abort = () => close({ allow: false, message: "Run stopped" });
    requests.set(id, close); signal.addEventListener("abort", abort, { once: true });
    send({ type: "request", request: { ...request, id } });
  });
}

async function runJob(input) {
  const repo = process.cwd();
  for (const path of ["rusubon.json", ".gitignore", "rusubon.mcp.example.json", ".rusubon/context.md", ".rusubon/inbox/reports", ".rusubon/inbox/archive", ".rusubon/runs", ...MEMORY_PREFIXES.map(prefix => `.rusubon/memory/${prefix}/.gitkeep`)]) localPath(repo, path);
  const onLine = text => emit({ type: "log", text });
  if (input.kind === "setup") { const result = saveSetup(repo, input.setup); initConfig(); return result; }
  if (input.kind === "init") { initConfig(); return { message: "Workspace initialized" }; }
  if (input.kind === "decline") {
    reportDetail(repo, input.source.value);
    localPath(repo, `.rusubon/inbox/archive/${input.source.value}.md`);
    localPath(repo, `.rusubon/memory/noise/${input.source.value}.md`);
    return decline(input.source.value, input.reason);
  }
  if (input.kind === "login") {
    const bin = input.runner === "claude" ? process.env.RUSUBON_CLAUDE || "claude" : "codex";
    emit({ type: "message", text: "Complete sign-in in the browser opened by your runner." });
    await mustCommand(bin, input.runner === "claude" ? ["auth", "login", "--claudeai"] : ["login"], { cwd: repo, signal: controller.signal, timeoutMs: 5 * 60_000, onLine });
    return { message: "Signed in. Refresh the connection." };
  }
  if (input.kind === "connect_mcp") {
    const bin = input.runner === "claude" ? process.env.RUSUBON_CLAUDE || "claude" : "codex";
    let state = await inspect(input.runner, repo);
    if (!state.authenticated) throw new Error("Sign in to this runner before connecting PostHog");
    let name = state.mcp?.[0]?.name;
    if (!name) {
      name = "rusubon-posthog";
      for (let suffix = 2; state.serverNames?.includes(name); suffix++) name = `rusubon-posthog-${suffix}`;
      const args = input.runner === "claude" ? ["mcp", "add", "--transport", "http", "--scope", "user", name, "https://mcp.posthog.com/mcp"] : ["mcp", "add", name, "--url", "https://mcp.posthog.com/mcp"];
      await mustCommand(bin, args, { cwd: repo, signal: controller.signal, timeoutMs: 5 * 60_000, onLine });
      state = await inspect(input.runner, repo);
    }
    if (!state.mcp?.some(row => row.connected)) {
      emit({ type: "message", text: "Authorize the official PostHog connection in your browser." });
      await mustCommand(bin, ["mcp", "login", name], { cwd: repo, signal: controller.signal, timeoutMs: 5 * 60_000, onLine });
    }
    return { message: "PostHog configured in your runner. Refresh the connection." };
  }
  const config = loadConfig();
  if (input.kind === "scout" && input.scoutScope?.revision) assertSetupRevision(repo, input.scoutScope.revision);
  const requested = input.kind === "pr" ? { spec: input.specSelection, implementation: input.selection } : { scout: input.selection };
  const connections = new Map(await Promise.all([...new Set(Object.values(requested).map(choice => choice.runner))].map(async runner => [runner, await inspect(runner, repo)])));
  const selections = {};
  for (const [role, choice] of Object.entries(requested)) {
    const connection = connections.get(choice.runner);
    if (!connection.authenticated) throw new Error(`Sign in to ${choice.runner} for ${role} before launching`);
    selections[role] = validateSelection(choice, connection.models, role);
  }
  const selection = selections.implementation || selections.scout;
  const connection = connections.get(selection.runner);
  Object.assign(config, selection);
  if (input.kind === "pr") { config.spec = selections.spec; config.implementation = selection; }
  const official = connection.mcp.filter(row => row.connected);
  const connectedMcp = runner => connections.get(runner)?.mcp.some(row => row.connected) ? "posthog: connected" : "";
  const probes = { ...defaultProbes(), claudeAuth: () => ({ loggedIn: connections.get("claude")?.authenticated }), codexAuth: () => ({ loggedIn: connections.get("codex")?.authenticated }), claudeMcpList: () => connectedMcp("claude"), codexMcpList: () => connectedMcp("codex") };
  const run = async (runner, prompt, options) => {
    if (controller.signal.aborted) throw new Error("Run stopped");
    const role = input.kind === "pr" ? options.phase === "research" ? "spec" : "implementation" : "scout";
    const expected = selections[role];
    if (runner !== expected.runner) throw new Error(`Runner changed for ${role}`);
    const chosen = validateSelection({ runner, model: options.model || expected.model, effort: options.effort || expected.effort }, connections.get(runner).models, role);
    emit({ type: "model", ...chosen, role, phase: options.phase || input.kind });
    const adapter = chosen.runner === "claude" ? runClaude : runCodex;
    return adapter(prompt, { ...chosen, cwd: process.cwd(), signal: controller.signal, emit, ask, timeoutMs: options.timeoutMs });
  };
  if (input.kind === "scout") {
    if (!official.length) {
      writeLocal(repo, `.rusubon/runs/${input.id}/close-out.md`, "no PostHog tools\n\nConnect the official PostHog MCP on this runner before scouting.\n");
      throw new Error("no PostHog tools. Connect the official PostHog MCP on this runner.");
    }
    config.read = { model: input.readModel || config.read.model || "claude-sonnet-5", effort: "low" };
    if (selection.runner === "claude") validateSelection({ runner: "claude", ...config.read }, connection.models);
    return runSkill("friction", config, probes, { run, runId: input.id, onEvent: emit, scope: input.scoutScope });
  }
  if (input.kind === "context") return draftContext({ config, about: input.about, run });
  if (input.kind === "pr") {
    const { worktree, base } = await preparePr(repo, input.source, input.id, { signal: controller.signal, emit });
    process.chdir(worktree);
    try {
      const result = await runPr({ raw: input.source.value, flags: { report: input.source.kind === "report", issue: input.source.kind === "issue" }, config, probes, run, baseBranch: base, onEvent: emit,
        beforePublish: async () => {
          // Synchronous verification may have delayed the IPC stop message.
          await new Promise(resolve => setImmediate(resolve));
          if (controller.signal.aborted || !process.connected) throw new Error("Run stopped before publishing");
          try { process.kill(supervisorPid, 0); } catch { throw new Error("Dashboard stopped before publishing"); }
        } });
      return { ...result, worktree, base };
    } finally { process.chdir(repo); }
  }
  throw new Error("Unknown dashboard operation");
}

let started = false;
process.on("message", async message => {
  if (message.type === "answer") { requests.get(message.id)?.(message.response); return; }
  if (message.type === "stop") { controller.abort(); return; }
  if (started) return; started = true;
  if (message.type === "probe") {
    try { const result = await inspect(message.runner, process.cwd()); process.send({ type: "probe_result", result }, () => process.exit(0)); }
    catch (error) { process.send({ type: "probe_result", error: safeText(error.message) }, () => process.exit(1)); }
    return;
  }
  if (message.type !== "start") process.exit(1);
  send({ type: "started" });
  let result, error;
  try { result = await runJob(message.input); } catch (failure) { error = safeText(failure.message); }
  const summary = error || result?.message || `Completed ${message.input.kind}`;
  const path = `.rusubon/runs/${message.input.id}/summary.md`;
  writeLocal(process.cwd(), path, `# ${message.input.kind}\n\n${summary}\n`);
  if (process.connected) process.send({ type: "result", result, error }, () => process.exit(error ? 1 : 0)); else process.exit(1);
});
process.on("disconnect", () => { controller.abort(); process.exit(1); });
