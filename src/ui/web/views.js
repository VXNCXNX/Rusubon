import { SCOUT_CHECKS, windowLabel } from "../../scout-scope.mjs";
export const icon = name => `<svg class="icon" viewBox="0 0 20 20" aria-hidden="true">${({ clock: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4l3 2"/>', check: '<path d="m5 10 3 3 7-7"/>', arrow: '<path d="M5 15 15 5M5 5h10v10"/>' })[name] || ""}</svg>`;
const stateIcon = complete => `<span class="icon-swap" data-complete="${complete}" aria-hidden="true">${icon("clock")}${icon("check")}</span>`;
export const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const ended = job => ["completed", "failed", "stopped", "needs_attention"].includes(job.status);
export const labels = { scout: "Friction scout", context: "Draft product context", pr: "Research to draft PR", setup: "Save setup", init: "Initialize workspace", decline: "Decline finding", login: "Agent sign-in", connect_mcp: "Connect PostHog" };
export const statuses = { starting: "Starting", running: "Running", waiting: "Needs your input", stopping: "Stopping", completed: "Completed", failed: "Failed", stopped: "Stopped", needs_attention: "Needs attention" };
export const badge = job => `<span class="badge ${escape(job.status)}">${escape(statuses[job.status] || job.status)}</span>`;
export const date = value => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export const duration = job => { const seconds = Math.max(0, Math.round(((job.finishedAt ? new Date(job.finishedAt) : Date.now()) - new Date(job.startedAt)) / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; };
export const modelLabel = id => ({ "claude-sonnet-5": "Sonnet 5", "claude-opus-5": "Opus 5", "claude-fable-5-1": "Fable 5.1", "gpt-5.6-luna": "GPT-5.6 Luna", "gpt-5.6-terra": "GPT-5.6 Terra", "gpt-5.6-sol": "GPT-5.6 Sol", "gpt-6-astra": "GPT-6 Astra" })[id] || id;
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
  return { ready: true, text: "Ready to scout", detail: selection.runner === "claude" ? `SQL analysis, then qualified session review with ${modelLabel(w.config.read.model)} · low.` : "SQL analysis. Findings stay in your inbox for review." };
}

export function modelControls(state, selection, role = "scout") {
  const connection = state.connections[selection.runner], busy = state.jobs.some(job => !ended(job));
  const allowed = state.roleModels[role][selection.runner], prefix = role === "scout" ? "" : `${role}-`;
  const models = allowed.map(spec => connection?.models?.find(row => row.id === spec.id) || { ...spec, available: false, efforts: [] });
  const model = models.find(row => row.id === selection.model), available = model?.available && !connection?.checking;
  const roleLabel = role === "spec" ? "Spec creator" : role === "implementation" ? "Implementation" : "Scout";
  return `<label>Agent<select data-choice="runner" aria-label="${roleLabel} agent" id="${prefix}runner-select" ${busy ? "disabled" : ""}>${option("claude", "Claude Code", selection.runner === "claude")}${option("codex", "Codex", selection.runner === "codex")}</select></label>
    <label>Model<select data-choice="model" aria-label="${roleLabel} model" id="${prefix}model-select" ${busy || !connection?.authenticated ? "disabled" : ""}>${models.map(row => option(row.id, row.label + (row.available ? "" : " · unavailable"), row.id === selection.model, !row.available)).join("")}</select></label>
    <label>Effort<select data-choice="effort" aria-label="${roleLabel} effort" id="${prefix}effort-select" ${busy || !available ? "disabled" : ""}>${(available ? model.efforts : [selection.effort]).map(effort => option(effort, effort, effort === selection.effort)).join("")}</select></label>`;
}

export function runList(jobs) {
  if (!jobs.length) return `<div class="empty"><h3>Your first run starts here.</h3><p>Once setup is ready, launch a scout. Its progress, decisions, and evidence will appear here.</p></div>`;
  return jobs.map(job => `<button type="button" class="history" data-key="${escape(job.id)}" data-job="${escape(job.id)}"><div><strong>${escape(labels[job.kind] || job.kind)}${job.source ? ` <span class="muted">/ ${escape(job.source.value)}</span>` : ""}</strong><p>${escape(date(job.startedAt))} · <span data-duration="${escape(job.id)}">${escape(duration(job))}</span>${job.specSelection ? ` · Spec: ${escape(modelLabel(job.specSelection.model))} · ${escape(job.specSelection.effort)}` : ""}${job.selection ? ` · ${job.specSelection ? "Build: " : ""}${escape(modelLabel(job.selection.model))} · ${escape(job.selection.effort)}` : ""}</p></div>${badge(job)}</button>`).join("");
}

export function findingList(rows, archived) {
  if (!rows.length) return `<div class="empty"><h3>${archived ? "No archived findings." : "Nothing waiting for review."}</h3><p>${archived ? "Declined findings stay here, with your reason saved to scout memory." : "A scout only files a finding when the evidence qualifies. No reports can be a useful result, too."}</p></div>`;
  return rows.map(row => `<button class="history" type="button" data-key="${escape(row.slug)}" data-report="${escape(row.slug)}"><div><strong>${escape(row.title)}</strong><p>${escape(row.slug)} · ${escape(date(row.modifiedAt))}</p></div><span class="badge">${escape(row.priority)}</span></button>`).join("");
}

export function reportView(report, selection, { prReady, busy }, specSelection = selection) {
  return `<button class="text-button back" type="button" data-back-findings>← All findings</button><div class="row"><span class="badge">${escape(report.priority)} · ${report.archived ? "Archived" : "Requires human input"}</span><code>${escape(report.path)}</code></div><article class="prose">${report.html}</article>${report.archived ? "" : `<div class="finding-actions"><h2>What should happen next?</h2><p class="caption">Research and implement in a separate worktree from committed HEAD. Publish a verified draft PR for review.</p><p class="caption" data-pr-models>${escape(prModelSummary(specSelection, selection))}</p><button class="text-button" data-page="research" type="button">Change agent roles</button><div class="actions section-title"><button type="button" class="button primary" data-report-pr="${escape(report.slug)}" ${!prReady || busy ? "disabled" : ""}>Research & create draft PR</button><button type="button" class="button" data-decline-toggle>Decline finding</button></div><form class="decline-form" id="decline-form" hidden><label>Why isn't this actionable?<textarea name="reason" rows="3" placeholder="Help future scouts avoid this noise." required></textarea></label><button class="button" type="submit" data-report-archive ${busy ? "disabled" : ""}>Archive & remember reason</button></form></div>`}`;
}

export const prModelSummary = (spec, implementation) => `Spec: ${modelLabel(spec.model)} · ${spec.effort}. Implementation: ${modelLabel(implementation.model)} · ${implementation.effort}.`;

export function connectionViews(state) {
  const busy = state.jobs.some(job => !ended(job));
  return ["claude", "codex"].map(runner => {
    const c = state.connections[runner], connected = c?.authenticated, mcp = c?.mcp?.find(row => row.connected);
    return `<div class="panel connection" data-key="${runner}"><div class="row"><h2>${runner === "claude" ? "Claude Code" : "Codex"}</h2><span class="badge ${!connected && !c?.checking ? "needs_attention" : ""}">${stateIcon(Boolean(connected && !c?.checking))}${c?.checking || !c ? "Checking…" : connected ? "Connected" : "Not connected"}</span></div><p class="caption">${escape(c?.error || (connected ? `${c.billing || "Runner login"} · ${c.models.filter(row => row.available).length} models available` : "Uses the account signed in through your local CLI."))}</p><div class="connection-line"><span>Official PostHog MCP</span><span class="muted">${mcp ? `${mcp.tools.length} tools connected` : c?.checking ? "Checking…" : "Not connected"}</span></div><div class="actions"><button class="button" type="button" data-connect="${runner}" data-kind="${connected ? "connect_mcp" : "login"}" ${busy || c?.checking || mcp ? "disabled" : ""}>${connected ? "Connect PostHog" : "Sign in"}</button><button class="text-button" type="button" data-refresh="${runner}" ${c?.checking ? "disabled" : ""}>Check again</button></div></div>`;
  }).join("");
}

export function jobView(job) {
  const phases = new Map(); for (const event of job.events) if (event.type === "phase") phases.set(event.name, event);
  const selection = job.selection;
  const progress = phases.size ? `<div class="panel" data-key="phases"><h2>Run progress</h2><ol class="timeline">${[...phases.values()].map(phase => `<li class="${escape(phase.status)}" data-key="${escape(phase.name)}"><span class="step-dot">${stateIcon(phase.status === "completed")}</span><span>${escape(phase.name)}</span><span class="caption">${escape(phase.status === "running" && ended(job) ? "Incomplete" : statuses[phase.status] || phase.status)}</span></li>`).join("")}</ol></div>` : !ended(job) ? `<p class="caption">${job.status === "starting" ? "Starting the local runner…" : "Your agent is working. Activity appears below as it arrives."}</p>` : "";
  return `<button type="button" class="text-button back" data-key="back" data-page="runs">← All runs</button><div class="heading" data-key="job-heading"><div><div class="eyebrow">${escape(date(job.startedAt))}</div><h1 id="job-title">${escape(labels[job.kind] || job.kind)}</h1><div class="job-meta">${selection ? `<span>${job.specSelection ? "Implementation: " : ""}${selection.runner === "claude" ? "Claude Code" : "Codex"} · ${escape(modelLabel(selection.model))} · ${escape(selection.effort)}</span>` : ""}${job.specSelection ? `<span>Spec: ${escape(modelLabel(job.specSelection.model))} · ${escape(job.specSelection.effort)}</span>` : ""}<span data-job-duration data-duration="${escape(job.id)}">${escape(duration(job))}</span>${job.source ? `<span>${escape(job.source.value)}</span>` : ""}</div></div><div class="actions">${badge(job)}${!ended(job) ? `<button class="button" type="button" data-stop="${escape(job.id)}" ${job.status === "stopping" ? "disabled" : ""}>Stop run</button>` : ["scout", "pr"].includes(job.kind) ? `<button class="button" type="button" data-rerun>${job.scoutScope ? "Review & rerun" : "Run again"}</button>` : `<button class="button" type="button" data-page="setup">Back to setup</button>`}</div></div>${job.error ? `<div class="notice error" data-key="job-error">${escape(job.error)}</div>` : ""}${job.result?.url ? `<p class="notice" data-key="job-result"><a href="${escape(safeUrl(job.result.url))}" target="_blank" rel="noopener noreferrer">Open draft PR for review ↗</a></p>` : ""}${job.result?.worktree || job.worktree ? `<div class="repo-strip" data-key="worktree"><span class="caption">Worktree</span><code>${escape(job.result?.worktree || job.worktree)}</code></div>` : ""}${job.scoutScope ? `<div class="job-overview" data-key="overview">${scopeView(job.scoutScope)}${progress}</div>` : progress}`;
}

export function scopeView(scope) {
  const checks = scope.options.checks.map(id => SCOUT_CHECKS.find(row => row.id === id)?.label || id);
  return `<div class="panel run-scope" data-key="scope"><div class="row"><h2>Investigation</h2><span class="badge">Saved at launch</span></div><dl><div><dt>Source</dt><dd>PostHog · Project ${escape(scope.source.projectId)} · ${escape(scope.source.region.toUpperCase())}</dd></div><div><dt>Period</dt><dd>${escape(windowLabel(scope.window))}<small>Previous ${scope.window.days} days from ${escape(scope.window.baselineStart.slice(0, 10))}</small></dd></div><div><dt>Focus</dt><dd>${scope.paths.map(escape).join(", ")}</dd></div><div><dt>Checks</dt><dd>${checks.map(escape).join(" · ")}</dd></div></dl>${scope.options.note ? `<p class="scope-run-note">${escape(scope.options.note)}</p>` : ""}<details><summary>Context & query boundaries</summary><p class="caption">Analysis: ${escape(scope.window.start)} to ${escape(scope.window.end)} (end excluded).${scope.options.checks.some(id => ["coverage", "replay"].includes(id)) ? ` Diagnostic history starts ${escape(scope.window.historyStart.slice(0, 10))}.` : ""}</p><pre>${escape(scope.context)}</pre></details></div>`;
}

export function safeUrl(value) { try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : "#"; } catch { return "#"; } }

export function activityView(job) {
  const activity = job.events.filter(event => ["message", "tool", "model", "selection_verified"].includes(event.type));
  const logs = job.events.filter(event => event.type === "log");
  const usages = job.events.filter(event => event.type === "usage");
  return `<div class="section-title" data-key="activity-heading"><h2>Agent activity</h2><span class="caption">${ended(job) ? "Saved transcript" : "Live from your runner"}</span></div><div class="activity" data-key="activity">${activity.length ? activity.slice(-100).map(event => event.type === "message" ? `<div class="activity-message" data-key="event-${event.sequence}">${escape(event.text)}</div>` : ["model", "selection_verified"].includes(event.type) ? `<p class="caption" data-key="event-${event.sequence}">${escape(event.type === "selection_verified" ? "Runner verified" : event.phase)} · ${escape(modelLabel(event.model))} · ${escape(event.effort)}</p>` : `<details class="tool" data-key="event-${event.sequence}" data-event="${event.sequence}"><summary>${escape(event.name)}${event.status ? `<span class="muted">${escape(event.status)}</span>` : ""}</summary><pre>${escape(event.text || "No additional detail")}</pre></details>`).join("") : `<p class="caption">${ended(job) ? "No agent messages were recorded for this operation." : "Waiting for the first activity."}</p>`}</div>${logs.length ? `<details class="logs" data-key="logs" data-event="logs"><summary>Runner logs (${logs.length})</summary><pre>${escape(logs.map(event => event.text).join("\n"))}</pre></details>` : ""}${usages.length ? `<details class="usage" data-key="usage" data-event="usage"><summary>Usage reported by the runner</summary><pre>${escape(JSON.stringify(usages.map(({ usage, durationMs }) => ({ usage, durationMs })), null, 2))}</pre></details>` : ""}${job.logTruncated ? `<p class="caption">The saved log reached its size limit. Some output was omitted.</p>` : ""}`;
}
