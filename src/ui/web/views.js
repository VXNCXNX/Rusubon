import { SCOUT_CHECKS, resolveScout, windowLabel } from "../../scout-scope.mjs";
export const stateIcon = complete => `<span class="dot ${complete ? "on" : "off"}" aria-hidden="true"></span>`;
export const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const ended = job => ["completed", "failed", "stopped", "needs_attention"].includes(job.status);
export const labels = { scout: "Scout", context: "Draft product context", pr: "Research to draft PR", setup: "Save setup", init: "Initialize workspace", decline: "Decline finding", login: "Agent sign-in", connect_mcp: "Connect PostHog", inbox_pull: "Pull from PostHog" };
export const scoutJobLabel = scope => `${resolveScout(scope?.options?.skill || "friction").label} scout`;
export const statuses = { starting: "Starting", running: "Running", waiting: "Needs your input", stopping: "Stopping", completed: "Completed", failed: "Failed", stopped: "Stopped", needs_attention: "Needs attention" };
const dots = { starting: "busy", running: "busy", waiting: "busy", stopping: "busy", completed: "on", failed: "bad", stopped: "off", needs_attention: "off" };
const statusDot = status => `<span class="dot ${dots[status] || "off"}" aria-hidden="true"></span>`;
export const badge = job => `<span class="badge ${escape(job.status)}">${escape(statuses[job.status] || job.status)}</span>`;
export const date = value => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export const duration = job => { const seconds = Math.max(0, Math.round(((job.finishedAt ? new Date(job.finishedAt) : Date.now()) - new Date(job.startedAt)) / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; };
export const modelLabel = id => ({ "claude-sonnet-5": "Sonnet 5", "claude-opus-5": "Opus 5", "claude-fable-5-1": "Fable 5.1", "gpt-5.6-luna": "GPT-5.6 Luna", "gpt-5.6-terra": "GPT-5.6 Terra", "gpt-5.6-sol": "GPT-5.6 Sol", "gpt-6-astra": "GPT-6 Astra" })[id] || id;
export const permissionLabel = mode => mode === "auto" ? "Auto" : mode === "ask" ? "Ask" : mode === "yolo" ? "YOLO" : "Invalid";
export const option = (value, label, selected, disabled = false) => `<option value="${escape(value)}" ${selected ? "selected" : ""} ${disabled ? "disabled" : ""}>${escape(label)}</option>`;

export function readiness(state, selection) {
  const w = state.workspace, connection = state.connections[selection.runner];
  if (state.jobs.some(job => !ended(job))) return { ready: false, text: "A run is active", detail: "Open the active run to follow progress or respond to your agent." };
  if (!w.initialized) return { ready: false, text: "Set up your workspace", detail: "Connect an agent and save your product context to get started." };
  if (w.error) return { ready: false, text: "Check configuration", detail: w.error };
  if (!/^\d+$/.test(w.config.posthog.projectId) || !["us", "eu", "https://us.posthog.com", "https://eu.posthog.com"].includes(w.config.posthog.host)) return { ready: false, text: "PostHog needs setup", detail: "Save your project ID and region in Setup." };
  if (!w.confirmed) return { ready: false, text: "Review product context", detail: "Confirm your money paths and intentional friction in Setup." };
  if (!connection || connection.checking) return { ready: false, text: "Checking connection", detail: "Reading the installed runner's account and model capabilities." };
  if (!connection.authenticated) return { ready: false, text: "Connect your agent", detail: connection.error || "Sign in to the selected runner in Setup." };
  const model = connection.models?.find(row => row.id === selection.model);
  if (!model?.available || !model.efforts.includes(selection.effort)) return { ready: false, text: "Model unavailable", detail: "Choose a model and effort supported by this connection." };
  if (!connection.mcp?.some(row => row.connected)) return { ready: false, text: "Connect PostHog", detail: "Authorize the official PostHog MCP for this runner in Setup." };
  if (selection.runner === "claude" && !connection.models.some(row => row.id === w.config.read.model && row.available && row.efforts.includes("low"))) return { ready: false, text: "Review model unavailable", detail: "Choose an available Claude session-review model in Setup." };
  return { ready: true, text: "Ready to scout", detail: "" };
}

function scoutOutcome(job) {
  if (job.kind !== "scout" || !["completed", "needs_attention"].includes(job.status) || !Array.isArray(job.result?.reports)) return null;
  const result = job.result, count = result.reports.length;
  const incomplete = job.status === "needs_attention" || result.mcp === "missing" || result.timedOut;
  const title = incomplete ? "Investigation incomplete" : count ? `${count} finding${count === 1 ? "" : "s"} filed` : "No findings filed";
  const description = result.mcp === "missing" ? "PostHog tools were unavailable. This run could not establish whether anything needs attention."
    : result.timedOut ? "The run reached its time limit. Review the close-out for partial results and remaining work."
    : incomplete ? "Review the close-out for the evidence limits and remaining work."
    : count ? "Review the evidence in your inbox and decide what deserves a fix."
    : "This run completed without creating or updating a report. The close-out explains what was checked, the evidence limits, and why nothing was filed.";
  const newCount = result.reports.filter(row => row.kind === "new").length;
  const updatedCount = result.reports.filter(row => row.kind === "updated").length;
  const memoryCount = result.memory?.length || 0;
  return { title, description, count, details: `${newCount} new, ${updatedCount} updated, ${memoryCount} memory update${memoryCount === 1 ? "" : "s"}.` };
}

function scoutOutcomeView(job) {
  const outcome = scoutOutcome(job);
  if (!outcome) return "";
  const closeOut = job.artifacts?.find(row => row.key.endsWith("/close-out.md"));
  return `<section class="section scout-outcome" data-key="scout-outcome" aria-labelledby="scout-outcome-title"><h2>Run outcome</h2>
    <h3 class="outcome-title" id="scout-outcome-title">${escape(outcome.title)}</h3>
    <p class="outcome-text">${escape(outcome.description)}</p>
    <p class="caption outcome-counts">${escape(outcome.details)}</p>
    ${closeOut || outcome.count ? `<div class="actions">${closeOut ? `<button class="btn" type="button" data-artifact="${escape(closeOut.key)}">Read results &amp; explanation</button>` : ""}${outcome.count ? `<button class="btn primary" type="button" data-page="inbox" data-filter="open">View findings</button>` : ""}</div>` : ""}
  </section>`;
}

export function modelControls(state, selection, role = "scout") {
  const connection = state.connections[selection.runner], busy = state.jobs.some(job => !ended(job));
  const allowed = state.roleModels[role][selection.runner], prefix = role === "scout" ? "" : `${role}-`;
  const models = allowed.map(spec => connection?.models?.find(row => row.id === spec.id) || { ...spec, available: false, efforts: [] });
  const model = models.find(row => row.id === selection.model), available = model?.available && !connection?.checking;
  const roleLabel = role === "spec" ? "Spec creator" : role === "implementation" ? "Implementation" : "Scout";
  return `<label>Agent<select data-choice="runner" aria-label="${roleLabel} agent" id="${prefix}runner-select" ${busy ? "disabled" : ""}>${option("claude", "Claude Code", selection.runner === "claude")}${option("codex", "Codex", selection.runner === "codex")}</select></label>
    <label>Model<select data-choice="model" aria-label="${roleLabel} model" id="${prefix}model-select" ${busy || !connection?.authenticated ? "disabled" : ""}>${models.map(row => option(row.id, row.label + (row.available ? "" : ", unavailable"), row.id === selection.model, !row.available)).join("")}</select></label>
    <label>Effort<select data-choice="effort" aria-label="${roleLabel} effort" id="${prefix}effort-select" ${busy || !available ? "disabled" : ""}>${(available ? model.efforts : [selection.effort]).map(effort => option(effort, effort, effort === selection.effort)).join("")}</select></label>`;
}

export function runList(jobs) {
  if (!jobs.length) return `<div class="empty"><p>No runs yet. Launch a scout to start.</p></div>`;
  return jobs.map(job => {
    const outcome = scoutOutcome(job), selection = job.selection;
    const models = selection && job.specSelection ? prModelSummary(job.specSelection, selection) : selection ? `${modelLabel(selection.model)}, ${selection.effort}` : "";
    return `<button type="button" class="row run-row" data-key="${escape(job.id)}" data-job="${escape(job.id)}">${statusDot(job.status)}<div><strong>${escape(job.kind === "scout" ? scoutJobLabel(job.scoutScope) : labels[job.kind] || job.kind)}</strong>${outcome ? `<span class="run-outcome">${escape(outcome.title)}</span>` : ""}<span class="meta"><span>${escape(date(job.startedAt))}</span><span data-duration="${escape(job.id)}">${escape(duration(job))}</span>${job.source ? `<code>${escape(job.source.value)}</code>` : ""}${models ? `<span>${escape(models)}</span>` : ""}</span></div>${job.status === "completed" ? `<span class="sr-only">${statuses.completed}</span>` : `<span class="caption run-status ${escape(job.status)}">${escape(statuses[job.status] || job.status)}</span>`}</button>`;
  }).join("");
}

export const stamp = (priority, size = "") => { const level = /^P[123]$/i.test(priority || "") ? priority.toUpperCase() : ""; return `<span class="stamp ${level ? level.toLowerCase() : "p3"} ${size}" aria-label="Priority ${escape(level || "unknown")}">${escape(level || "?")}</span>`; };
export const sourceLabel = row => row.source === "posthog" ? "From PostHog" : "Scout";
const statusLabel = value => { const text = String(value || "").replace(/_/g, " "); return text ? text[0].toUpperCase() + text.slice(1) : ""; };

export function findingList(rows, archived, selected = "") {
  if (!rows.length) return `<div class="empty"><p>${archived ? "No archived findings yet. Declined findings land here with the reason you gave." : "No open findings. Launch a scout from Runs, or pull the reports PostHog has ready."}</p></div>`;
  return `<div class="rows">${rows.map(row => `<button class="row" type="button" data-key="${escape(row.slug)}" data-report="${escape(row.slug)}" ${row.slug === selected ? 'aria-current="true"' : ""}>${stamp(row.priority)}<div><strong>${escape(row.title)}</strong><span class="meta"><b>${escape(sourceLabel(row))}</b><span>${escape(date(row.modifiedAt))}</span></span></div></button>`).join("")}</div>`;
}

export function emptyReport(rows, archived) {
  if (!rows.length) return `<div class="empty"><h2>${archived ? "Nothing archived" : "Nothing waiting"}</h2><p>${archived ? "Findings you decline are kept here with the reason, so future scouts skip the same noise." : "Scouts file findings here after a run. Pull from PostHog mirrors the reports its self-driving agent has ready."}</p></div>`;
  return `<div class="empty"><h2>Pick a finding</h2><p>Read the evidence, then research it into a draft PR or decline it with a reason.</p></div>`;
}

export function reportView(report, selection, { prReady, busy }, specSelection = selection) {
  const ph = report.posthog;
  const facts = ph
    ? `<dl class="facts"><div><dt>Source</dt><dd>PostHog self-driving</dd></div>${ph.status ? `<div><dt>Status there</dt><dd class="${ph.status === "ready" ? "ok" : ""}">${escape(statusLabel(ph.status))}</dd></div>` : ""}${ph.priority ? `<div><dt>Priority there</dt><dd>${escape(ph.priority)}</dd></div>` : ""}${report.pulledAt ? `<div><dt>Pulled</dt><dd>${escape(date(report.pulledAt))}</dd></div>` : ""}${ph.url ? `<a class="facts-link" href="${escape(safeUrl(ph.url))}" target="_blank" rel="noopener noreferrer">Open in PostHog</a>` : ""}</dl>`
    : `<dl class="facts"><div><dt>Source</dt><dd>Scout</dd></div>${report.modifiedAt ? `<div><dt>Updated</dt><dd>${escape(date(report.modifiedAt))}</dd></div>` : ""}${report.actionability ? `<div><dt>Actionability</dt><dd>${escape(statusLabel(report.actionability))}</dd></div>` : ""}</dl>`;
  return `<div class="doc"><div class="doc-top"><button class="link back" type="button" data-back-findings>Back</button>${stamp(report.priority, "lg")}<span>${report.archived ? "Archived" : "Requires human input"}</span><code class="path" title="${escape(report.path)}">${escape(report.path)}</code></div><h2 class="doc-title" tabindex="-1">${escape(report.title)}</h2>${report.explanationHtml ? `<p class="doc-lede">${report.explanationHtml}</p>` : ""}${facts}<article class="prose">${report.html}</article></div>${report.archived ? "" : `<form class="decline-form" id="decline-form" hidden><label>Why isn't this actionable?<textarea name="reason" rows="3" placeholder="Help future scouts avoid this noise." required></textarea></label><div class="actions"><button class="btn" type="button" data-decline-toggle>Keep it open</button><button class="btn primary" type="submit" data-report-archive ${busy ? "disabled" : ""}>Archive &amp; remember reason</button></div></form><div class="decide"><span class="roles"><span data-pr-models>${escape(prModelSummary(specSelection, selection))}</span><button class="link" type="button" data-page="research">Change</button></span><span class="acts"><button type="button" class="btn" data-decline-toggle>Decline</button><button type="button" class="btn primary" data-report-pr="${escape(report.slug)}" ${!prReady || busy ? "disabled" : ""}>Research &amp; draft PR</button></span></div>`}`;
}

export const prModelSummary = (spec, implementation) => `Spec ${modelLabel(spec.model)}, ${spec.effort}. Build ${modelLabel(implementation.model)}, ${implementation.effort}.`;

export function connectionViews(state) {
  const busy = state.jobs.some(job => !ended(job));
  return ["claude", "codex"].map(runner => {
    const c = state.connections[runner], connected = c?.authenticated, mcp = c?.mcp?.find(row => row.connected), checking = !c || c.checking;
    const models = connected ? c.models.filter(row => row.available).length : 0, tools = mcp?.tools.length;
    const dot = checking ? "busy" : c.error ? "bad" : connected && mcp ? "on" : "off";
    const agent = checking ? "Checking" : c.error || (connected ? `Signed in${c.billing === "API key" ? " with an API key" : ""}, ${models} ${models === 1 ? "model" : "models"} available` : "Not signed in");
    const action = connected && mcp ? "" : `<button class="btn" type="button" data-key="connect" data-connect="${runner}" data-kind="${connected ? "connect_mcp" : "login"}" ${busy || c?.checking || mcp ? "disabled" : ""}>${connected ? "Connect PostHog" : "Sign in"}</button>`;
    return `<div class="connection" data-key="${runner}"><div class="connection-agent"><span class="dot ${dot}" aria-hidden="true"></span><div><b>${runner === "claude" ? "Claude Code" : "Codex"}</b><small${!checking && c.error ? ' class="state bad"' : ""}>${escape(agent)}</small></div></div><div class="connection-mcp"><b>Official PostHog MCP</b><small${mcp ? ' class="state ok"' : ""}>${mcp ? `Connected, ${tools} ${tools === 1 ? "tool" : "tools"}` : checking ? "Checking" : "Not connected"}</small></div><div class="connection-actions">${action}<button class="link" type="button" data-key="refresh" data-refresh="${runner}" ${c?.checking ? "disabled" : ""}>Check again</button></div></div>`;
  }).join("");
}

export function jobView(job) {
  const phases = new Map(); for (const event of job.events) if (event.type === "phase") phases.set(event.name, event);
  const selection = job.selection, spec = job.specSelection;
  const agent = row => `${row.runner === "claude" ? "Claude Code" : "Codex"}, ${modelLabel(row.model)}, ${row.effort}`;
  const step = phase => phase.status === "running" && ended(job) ? ["stopped", "Incomplete"] : [phase.status, statuses[phase.status] || statusLabel(phase.status)];
  const progress = phases.size ? `<ol class="steps">${[...phases.values()].map(phase => { const [state, word] = step(phase); return `<li class="${escape(state)}" data-key="${escape(phase.name)}">${statusDot(state)}<span>${escape(phase.name)}</span><span class="caption">${escape(word)}</span></li>`; }).join("")}</ol>` : !ended(job) ? `<p class="caption">${job.status === "starting" ? "Starting the local runner…" : "Your agent is working. Activity appears below as it arrives."}</p>` : "";
  const action = !ended(job) ? `<button class="btn" type="button" data-stop="${escape(job.id)}" ${job.status === "stopping" ? "disabled" : ""}>Stop run</button>` : ["scout", "pr"].includes(job.kind) ? `<button class="btn" type="button" data-rerun>${job.scoutScope ? "Review &amp; rerun" : "Run again"}</button>` : ["decline", "inbox_pull"].includes(job.kind) ? `<button class="btn" type="button" data-page="inbox">Open the inbox</button>` : `<button class="btn" type="button" data-page="setup">Back to setup</button>`;
  return `<div class="job-head" data-key="job-head"><div><p class="job-date">${escape(date(job.startedAt))}</p><p class="job-meta">${spec ? `<span>Spec ${escape(agent(spec))}</span>` : ""}${selection ? `<span>${spec ? "Build " : ""}${escape(agent(selection))}</span><span>${permissionLabel(job.permissionMode === undefined ? "ask" : job.permissionMode)} permissions</span>` : ""}<span data-job-duration data-duration="${escape(job.id)}">${escape(duration(job))}</span>${job.source ? `<code>${escape(job.source.value)}</code>` : ""}</p></div><div class="job-actions">${badge(job)}${action}</div></div>${job.error ? `<div class="notice error" data-key="job-error">${escape(job.error)}</div>` : ""}${job.result?.url ? `<p class="notice" data-key="job-result"><a href="${escape(safeUrl(job.result.url))}" target="_blank" rel="noopener noreferrer">Open draft PR for review</a></p>` : ""}${job.result?.worktree || job.worktree ? `<p class="job-path" data-key="worktree"><span>Worktree</span><code>${escape(job.result?.worktree || job.worktree)}</code></p>` : ""}${scoutOutcomeView(job)}${job.scoutScope ? scopeView(job.scoutScope) : ""}${progress ? `<section class="section run-progress" data-key="phases"><h2>Run progress</h2>${progress}</section>` : ""}`;
}

export function scopeView(scope) {
  const checks = scope.options.checks.map(id => SCOUT_CHECKS.find(row => row.id === id)?.label || id);
  const pair = (term, value) => `<div><dt>${term}</dt><dd>${value}</dd></div>`;
  return `<section class="section run-scope" data-key="scope"><div class="section-head"><h2>Investigation</h2><span class="caption">Saved at launch</span></div><dl class="pairs">${pair("Scout", escape(resolveScout(scope.options.skill).label))}${pair("Source", `PostHog project ${escape(scope.source.projectId)}, ${escape(scope.source.region.toUpperCase())}`)}${pair("Period", `${escape(windowLabel(scope.window))}<small>Compared with the ${scope.window.days} days from ${escape(scope.window.baselineStart.slice(0, 10))}</small>`)}${pair("Focus", scope.paths.map(path => `<code>${escape(path)}</code>`).join(", "))}${pair("Checks", checks.map(escape).join(", "))}${scope.options.note ? pair("Run context", escape(scope.options.note)) : ""}</dl><details class="scope-context"><summary>Context &amp; query boundaries</summary><p class="caption">Analysis: ${escape(scope.window.start)} to ${escape(scope.window.end)} (end excluded).${scope.options.checks.some(id => ["coverage", "replay"].includes(id)) ? ` Diagnostic history starts ${escape(scope.window.historyStart.slice(0, 10))}.` : ""}</p><pre>${escape(scope.context)}</pre></details></section>`;
}

export function safeUrl(value) { try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : "#"; } catch { return "#"; } }

export function authorizationUrl(value) {
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password) return null;
    return url.protocol === "https:" || (url.protocol === "http:" && loopback) ? url.href : null;
  } catch { return null; }
}

export function activityView(job) {
  const activity = job.events.filter(event => ["message", "tool", "model", "selection_verified"].includes(event.type));
  const logs = job.events.filter(event => event.type === "log");
  const usages = job.events.filter(event => event.type === "usage");
  const entry = event => event.type === "message" ? `<p class="activity-message" data-key="event-${event.sequence}">${escape(event.text)}</p>`
    : ["model", "selection_verified"].includes(event.type) ? `<p class="caption activity-model" data-key="event-${event.sequence}">${escape(event.type === "selection_verified" ? "Runner verified" : /^\d+$/.test(event.phase) ? `Phase ${event.phase}` : statusLabel(String(event.phase).replace(/-/g, " ")))}, ${escape(modelLabel(event.model))}, ${escape(event.effort)}</p>`
    : `<details class="tool" data-key="event-${event.sequence}" data-event="${event.sequence}"><summary>${escape(event.name)}${event.status ? `<span class="tool-status ${escape(event.status)}">${escape(statusLabel(event.status))}</span>` : ""}</summary><pre>${escape(event.text || "No additional detail")}</pre></details>`;
  return `<section class="section run-activity" data-key="activity-section"><div class="section-head"><h2>Agent activity</h2><span class="caption">${ended(job) ? "Saved transcript" : "Live from your runner"}</span></div><div class="activity" data-key="activity">${activity.length ? activity.slice(-100).map(entry).join("") : `<p class="caption">${ended(job) ? "No agent messages were recorded for this operation." : "Waiting for the first activity."}</p>`}</div>${logs.length ? `<details class="runner-detail" data-key="logs" data-event="logs"><summary>Runner logs (${logs.length})</summary><pre>${escape(logs.map(event => event.text).join("\n"))}</pre></details>` : ""}${usages.length ? `<details class="runner-detail" data-key="usage" data-event="usage"><summary>Usage reported by the runner</summary><pre>${escape(JSON.stringify(usages.map(({ usage, durationMs }) => ({ usage, durationMs })), null, 2))}</pre></details>` : ""}${job.logTruncated ? `<p class="caption">The saved log reached its size limit. Some output was omitted.</p>` : ""}</section>`;
}

export function agentStatus(state) {
  return ["claude", "codex"].map(runner => {
    const c = state.connections[runner], mcp = c?.mcp?.some(row => row.connected), checking = !c || c.checking;
    const dot = checking ? "busy" : !c.authenticated ? "off" : mcp ? "on" : "off";
    const text = checking ? "Checking" : !c.authenticated ? "Not signed in" : mcp ? "Signed in, PostHog connected" : "Signed in, PostHog not connected";
    return `<div class="agent" data-key="${runner}"><span class="dot ${dot}" aria-hidden="true"></span><div><b>${runner === "claude" ? "Claude Code" : "Codex"}</b><small>${escape(text)}</small></div></div>`;
  }).join("");
}
