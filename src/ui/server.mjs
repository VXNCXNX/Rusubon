import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Jobs, probe } from "./jobs.mjs";
import { MODEL_ALLOWLIST, ROLE_MODELS, SPEC_MODEL_ALLOWLIST, validateSavedSelection } from "./models.mjs";
import { assertSetupRevision, canonicalRepo, reportDetail, reports, workspaceState } from "./workspace.mjs";
import { artifacts, readArtifact } from "./artifacts.mjs";
import { safeText } from "./process.mjs";
import { acquireRepoLock } from "../lock.mjs";
import { resolveScoutScope } from "../scout-scope.mjs";

const ASSETS = new Map([["/", ["index.html", "text/html"]], ["/app.css", ["app.css", "text/css"]], ["/app.js", ["app.js", "text/javascript"]], ["/views.js", ["views.js", "text/javascript"]], ["/requests.js", ["requests.js", "text/javascript"]]]);
ASSETS.set("/refresh.js", ["refresh.js", "text/javascript"]);
ASSETS.set("/interface.js", ["interface.js", "text/javascript"]);
ASSETS.set("/scope.js", ["../../scout-scope.mjs", "text/javascript"]);
ASSETS.set("/scout-scope.mjs", ["../../scout-scope.mjs", "text/javascript"]);
ASSETS.set("/scope-controls.js", ["scope-controls.js", "text/javascript"]);
const json = (res, data, code = 200) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(data)); };
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) throw new Error("Expected application/json");
  let size = 0, chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 256_000) throw new Error("Request is too large"); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function validToken(actual, expected) { const a = Buffer.from(actual || ""), b = Buffer.from(expected); return a.length === b.length && timingSafeEqual(a, b); }
function source(value) {
  if (!value || !["report", "issue"].includes(value.kind) || typeof value.value !== "string" || value.value.length > 1000) throw new Error("Choose a finding or GitHub issue");
  if (value.kind === "report" && !/^[a-z0-9][a-z0-9-]*$/.test(value.value)) throw new Error("Invalid finding slug");
  if (value.kind === "issue" && !/^(#?\d+|https:\/\/[^\s]+\/issues\/\d+)$/.test(value.value)) throw new Error("Enter an issue number or full GitHub issue URL");
  return { kind: value.kind, value: value.value };
}

export async function startDashboard({ repo = process.cwd(), port = 0, open = true, jobs: suppliedJobs, probeRunner = probe } = {}) {
  repo = canonicalRepo(repo);
  const releaseServer = acquireRepoLock(repo, "ui.lock");
  let jobs;
  try {
    for (let attempt = 0; ; attempt++) {
      try { jobs = suppliedJobs || new Jobs(repo); break; }
      catch (error) { if (error.code !== "CONTEXT_DRAFT_STOPPING" || attempt >= 20) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
  } catch (error) { releaseServer(); throw error; }
  const token = randomBytes(32).toString("hex"), streams = new Set(), connections = new Map(), probing = new Map();
  let origin, shuttingDown = false;
  const changed = id => { for (const stream of streams) if (!stream.write(`data: ${JSON.stringify({ id })}\n\n`)) { stream.destroy(); streams.delete(stream); } };
  jobs.on("change", changed);
  const refreshConnection = runner => {
    if (!Object.hasOwn(MODEL_ALLOWLIST, runner)) throw new Error("Unsupported runner");
    if (probing.has(runner)) return probing.get(runner);
    connections.set(runner, { runner, checking: true }); changed();
    const pending = probeRunner(repo, runner).then(result => connections.set(runner, { ...result, checkedAt: new Date().toISOString() })).catch(error => connections.set(runner, { runner, error: safeText(error.message), models: SPEC_MODEL_ALLOWLIST[runner].map(row => ({ ...row, available: false, efforts: [] })), checkedAt: new Date().toISOString() })).finally(() => { probing.delete(runner); changed(); });
    probing.set(runner, pending); return pending;
  };
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return json(res, { error: "Untrusted origin" }, 403);
      const url = new URL(req.url, origin), path = url.pathname;
      if (req.method === "GET" && ASSETS.has(path)) {
        const [file, type] = ASSETS.get(path); res.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" }); res.end(readFileSync(fileURLToPath(new URL(`./web/${file}`, import.meta.url)))); return;
      }
      if (!validToken(req.headers["x-rusubon-token"], token)) return json(res, { error: "Open the dashboard using the URL printed by rusubon ui" }, 401);
      if (req.method === "GET" && path === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" }); res.write("data: {}\n\n"); streams.add(res);
        const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
        res.on("close", () => { clearInterval(heartbeat); streams.delete(res); }); return;
      }
      if (req.method === "GET" && path === "/api/state") return json(res, { workspace: workspaceState(repo), connections: Object.fromEntries(connections), jobs: jobs.list(), reports: reports(repo), archived: reports(repo, true), modelAllowlist: MODEL_ALLOWLIST, roleModels: ROLE_MODELS });
      const parts = path.split("/").filter(Boolean);
      if (req.method === "GET" && parts[0] === "api" && parts[1] === "reports" && parts.length === 3) return json(res, reportDetail(repo, decodeURIComponent(parts[2])));
      if (req.method === "GET" && parts[0] === "api" && parts[1] === "jobs" && parts.length === 3) {
        const job = jobs.detail(parts[2]); return json(res, { ...job, artifacts: artifacts(repo, job).map(({ key, label }) => ({ key, label })) });
      }
      if (req.method === "GET" && parts[1] === "jobs" && parts[3] === "artifact" && parts.length === 4) return json(res, readArtifact(repo, jobs.detail(parts[2]), url.searchParams.get("key")));
      if (req.method !== "POST") return json(res, { error: "Not found" }, 404);
      const input = await body(req);
      if (path === "/api/connections/refresh") { refreshConnection(input.runner); return json(res, { checking: true }, 202); }
      if (path === "/api/jobs") {
        if (!["init", "setup", "login", "connect_mcp", "context", "scout", "pr", "decline"].includes(input.kind)) throw new Error("Unsupported operation");
        const operation = { kind: input.kind };
        if (["login", "connect_mcp"].includes(input.kind)) { if (!Object.hasOwn(MODEL_ALLOWLIST, input.runner)) throw new Error("Unsupported runner"); operation.runner = input.runner; }
        if (["context", "scout", "pr"].includes(input.kind)) {
          operation.selection = validateSavedSelection(input.kind === "context" ? { ...input.selection, effort: "low" } : input.selection);
          operation.permissionMode = workspaceState(repo).config.permissionMode;
        }
        if (input.kind === "pr") operation.specSelection = validateSavedSelection(input.specSelection || workspaceState(repo).config.spec, "spec");
        if (input.kind === "scout" && input.scout !== undefined) {
          const workspace = workspaceState(repo);
          assertSetupRevision(repo, input.expectedRevision, { revision: workspace.revision });
          operation.scoutScope = resolveScoutScope(input.scout, workspace);
          if (safeText(operation.scoutScope.options.note) !== operation.scoutScope.options.note) throw new Error("Remove credentials from additional context before launching.");
        }
        if (["pr", "decline"].includes(input.kind)) operation.source = source(input.source);
        if (input.kind === "decline") { if (operation.source.kind !== "report" || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 10_000) throw new Error("A decline reason is required"); operation.reason = input.reason.trim(); }
        if (input.kind === "context") { if (typeof input.about !== "string" || input.about.length > 20_000) throw new Error("Describe the product in 20,000 characters or fewer"); operation.about = input.about; }
        if (input.kind === "setup") { if (!input.setup || typeof input.setup !== "object") throw new Error("Setup is required"); assertSetupRevision(repo, input.setup.expectedRevision); operation.setup = input.setup; }
        return json(res, jobs.start(operation), 202);
      }
      if (parts[0] === "api" && parts[1] === "jobs" && parts.length === 4 && parts[3] === "stop") return json(res, jobs.stop(parts[2]));
      if (parts[0] === "api" && parts[1] === "jobs" && parts.length === 4 && parts[3] === "answer") { await jobs.answer(parts[2], input.requestId, input.response); return json(res, { accepted: true }); }
      json(res, { error: "Not found" }, 404);
    } catch (error) { if (!res.headersSent) json(res, { error: safeText(error.message) }, error.statusCode || 400); else res.destroy(); }
  });
  try { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); }); }
  catch (error) { releaseServer(); throw error; }
  origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/#token=${token}`;
  if (open) {
    const child = spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }); child.on("error", () => {}); child.unref();
  }
  return { server, jobs, repo, url, token, origin, refreshConnection,
    async close() { if (shuttingDown) return; shuttingDown = true; for (const stream of streams) stream.end(); await jobs.close(); await new Promise(resolve => server.close(resolve)); releaseServer(); },
  };
}

export async function uiCommand({ repo, port, open }) {
  const dashboard = await startDashboard({ repo, port, open });
  console.log(`Rusubon dashboard\n${dashboard.url}\n\nRepository: ${dashboard.repo}\nKeep this process running. Ctrl-C stops active runs and preserves their files.`);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await dashboard.close(); process.exit(0); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
