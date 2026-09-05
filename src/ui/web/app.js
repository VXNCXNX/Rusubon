import { escape, ended, labels, duration, modelLabel, permissionLabel, modelControls, readiness, runList, findingList, reportView, prModelSummary, connectionViews, jobView, activityView } from "/views.js";
import { syncRequests } from "/requests.js";
import { createRefreshScheduler } from "/refresh.js";
import { updateMarkup, enterPage } from "/interface.js";
import { scopeControls } from "/scope-controls.js";
import { windowLabel } from "/scope.js";
import { usagePage } from "/usage.js";

const $ = id => document.getElementById(id);
const storage = { get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }, set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} } };
let token;
try { token = new URLSearchParams(location.hash.slice(1)).get("token") || sessionStorage.getItem("rusubon-token"); if (token) sessionStorage.setItem("rusubon-token", token); } catch { /* A fragment token still works without browser storage. */ }
if (location.hash) history.replaceState(null, "", location.pathname + location.search);
let state, selection, specSelection, implementationSelection, selectionKey, setupRevision, page = "runs", currentJob, report, filter = "open", dirtySetup = false, setupFilled = false, submitting = false, refreshing = false, refreshAgain = false;
const seenFinished = new Set();
let interactive = false;
let scoutControls;
const scrollPositions = new Map();
const usage = usagePage($("page-usage"), api);

async function api(path, data) {
  const response = await fetch(`/api${path}`, { method: data === undefined ? "GET" : "POST", headers: { "X-Rusubon-Token": token || "", ...(data === undefined ? {} : { "Content-Type": "application/json" }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`); return result;
}
function notice(text, error = false) { $("notice").textContent = text; $("notice").classList.toggle("error", error); $("notice").hidden = !text; }
function protect(action) { return async event => { try { await action(event); } catch (error) { notice(error.message, true); } }; }
function validStored(value, role = "scout") { const model = state.roleModels[role][value?.runner]?.find(row => row.id === value.model); return model && model.efforts.includes(value.effort); }
function saveSelection(value, role) { const key = role === "scout" ? selectionKey : `${selectionKey}:${role}`; storage.set(key, value); storage.set(`${key}:${value.runner}`, value); storage.set(`${key}:${value.model}`, value.effort); }
function busy() { return submitting || state?.jobs.some(job => !ended(job)); }
function agentReady(value = selection) { const c = state.connections[value.runner], m = c?.models?.find(row => row.id === value.model); return state.workspace.initialized && !busy() && c?.authenticated && !c.checking && m?.available && m.efforts.includes(value.effort); }
function prReady() { return agentReady(specSelection) && agentReady(implementationSelection); }

function navigate(next) {
  const changed = next !== page;
  if (changed) scrollPositions.set(page, window.scrollY);
  page = next;
  if (page === "usage") usage.load();
  for (const section of document.querySelectorAll("main>section")) section.hidden = section.id !== `page-${page}`;
  for (const button of document.querySelectorAll("nav [data-page]")) { if (button.dataset.page === (page === "job" ? "runs" : page)) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current"); }
  $("page-label").textContent = page === "job" ? labels[currentJob?.kind] || "Run" : page[0].toUpperCase() + page.slice(1);
  storage.set(`${selectionKey}:page`, { page: page === "job" ? "job" : page, jobId: currentJob?.id });
  if (changed && interactive) {
    enterPage($(`page-${page}`));
    window.scrollTo({ top: scrollPositions.get(page) || 0, behavior: "instant" });
    $("content").focus({ preventScroll: true });
  }
}
function fillSetup() {
  if (dirtySetup) return;
  const { config, context, confirmed } = state.workspace;
  $("project-id").value = /^\d+$/.test(config.posthog.projectId) ? config.posthog.projectId : "";
  $("posthog-host").value = config.posthog.host.includes("eu") ? "eu" : config.posthog.host.includes("us") && !config.posthog.host.includes("YOUR") ? "us" : "";
  $("product-context").value = context || "# Product\n\n\n# Money paths\n\n\n# Intentional friction\n\n\n# Out of scope\n\n";
  $("context-confirmed").checked = confirmed;
  $("read-model").value = config.read.model;
  $("permission-mode").value = config.permissionMode;
  permissionHelp();
  setupRevision = state.workspace.revision;
  setupFilled = true;
}
function permissionHelp() {
  $("permission-help").textContent = {
    auto: "The runner reviews tool actions automatically. Routine permissions need no clicks; some actions may still be blocked or require input.",
    ask: "Review tool permission requests in the dashboard. Headless CLI runs can deny actions that require approval.",
    yolo: "Skips tool permission checks. Codex also runs with full filesystem and network access.",
  }[$("permission-mode").value] || "Choose a permission mode to repair the saved setting.";
}
function renderState() {
  const w = state.workspace;
  $("repo-name").textContent = w.name; $("repo-path").textContent = w.repo;
  $("finding-count").textContent = state.reports.length || "";
  updateMarkup($("model-controls"), modelControls(state, selection));
  updateMarkup($("spec-model-controls"), modelControls(state, specSelection, "spec"));
  updateMarkup($("implementation-model-controls"), modelControls(state, implementationSelection, "implementation"));
  $("spec-help").textContent = specSelection.model === "claude-fable-5-1" ? "Fable 5.1 is selected for research and spec creation only. It can cost more than the other choices." : "Sol, Astra, or Fable 5.1 for deeper research, requirements, and design. Choose the effort separately.";
  $("pr-readiness").textContent = prReady() ? "Ready for a finding or issue" : busy() ? "A run is active" : "Connect both selected agents and choose supported efforts in Setup.";
  for (const summary of document.querySelectorAll("[data-pr-models]")) summary.textContent = prModelSummary(specSelection, implementationSelection);
  const ready = readiness(state, selection);
  const investigation = scoutControls.update(w, selection.runner, busy());
  $("readiness").textContent = ready.ready && investigation.error ? "Review scope" : ready.text;
  $("launch-help").textContent = ready.detail;
  $("scope-error").textContent = investigation.error; $("scope-error").hidden = !investigation.error;
  $("launch-summary").textContent = investigation.scope ? `${investigation.scope.options.checks.length} checks · ${investigation.scope.paths.length} ${investigation.scope.paths.length === 1 ? "path" : "paths"} · ${windowLabel(investigation.scope.window)}` : "";
  $("launch-scout").disabled = !ready.ready || !investigation.scope || submitting;
  $("model-help").textContent = `${permissionLabel(w.config.permissionMode)} permissions · ${selection.effort === "ultra" ? "ultra enables automatic delegation in the connected Codex runner." : "Model and effort are checked against your connected runner before each phase."}`;
  updateMarkup($("run-list"), runList(state.jobs));
  updateMarkup($("finding-list"), findingList(filter === "open" ? state.reports : state.archived, filter === "archived"));
  updateMarkup($("connections"), connectionViews(state));
  $("context-status").textContent = w.confirmed ? "Confirmed" : "Review required";
  $("setup-conflict").hidden = !setupFilled || setupRevision === w.revision;
  $("saved-selection").textContent = `Save the current investigation and agent defaults. Scout: ${modelLabel(selection.model)} · ${selection.effort}. ${prModelSummary(specSelection, implementationSelection)}`;
  $("save-setup").disabled = busy(); $("draft-context").disabled = !agentReady() || w.confirmed || dirtySetup;
  $("launch-issue").disabled = !prReady();
  if (!setupFilled) fillSetup();
  if (report) {
    for (const button of $("report-detail").querySelectorAll("[data-report-pr]")) button.disabled = !prReady();
    for (const button of $("report-detail").querySelectorAll("[data-report-archive]")) button.disabled = busy();
  }
}
function renderJob() {
  if (!currentJob) return;
  updateMarkup($("job-detail"), jobView(currentJob));
  updateMarkup($("job-activity"), activityView(currentJob));
  syncRequests($("requests"), currentJob.requests, async (requestId, response) => { await api(`/jobs/${currentJob.id}/answer`, { requestId, response }); await refresh(); });
  updateMarkup($("job-artifacts"), currentJob.artifacts?.length ? `<div class="section-title"><h2>Files from this run</h2><span class="caption">Available even after a stopped run</span></div><div class="artifact-links">${currentJob.artifacts.map(row => `<button type="button" class="button" data-key="${escape(row.key)}" data-artifact="${escape(row.key)}">${escape(row.label)}</button>`).join("")}</div>` : "");
}
async function refresh() {
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true;
  try {
    state = await api("/state");
    if (!selection) {
      selectionKey = `rusubon:${state.workspace.repo}:selection`;
      const saved = storage.get(selectionKey), config = state.workspace.config;
      selection = validStored(saved) ? saved : validStored(config) ? { runner: config.runner, model: config.model, effort: config.effort } : { runner: "claude", model: "claude-sonnet-5", effort: "high" };
      const savedSpec = storage.get(`${selectionKey}:spec`), savedImplementation = storage.get(`${selectionKey}:implementation`);
      specSelection = validStored(savedSpec, "spec") ? savedSpec : validStored(config.spec, "spec") ? config.spec : { runner: "codex", model: "gpt-5.6-sol", effort: "high" };
      implementationSelection = validStored(savedImplementation, "implementation") ? savedImplementation : validStored(config.implementation, "implementation") ? config.implementation : { ...selection };
      scoutControls = scopeControls($("scout-scope-controls"), storage.get(`${selectionKey}:scope`) || config.scout, value => { storage.set(`${selectionKey}:scope`, value); renderState(); });
      for (const job of state.jobs.filter(ended)) seenFinished.add(job.id);
    }
    for (const job of state.jobs.filter(ended)) if (!seenFinished.has(job.id)) {
      seenFinished.add(job.id);
      if (["setup", "init", "context"].includes(job.kind)) { if (job.status === "completed") dirtySetup = false; setupFilled = false; }
      if (["login", "connect_mcp"].includes(job.kind)) for (const runner of ["claude", "codex"]) api("/connections/refresh", { runner }).catch(() => {});
    }
    renderState();
    if (page === "usage") usage.load();
    if (currentJob) { const id = currentJob.id; const detail = await api(`/jobs/${id}`); if (currentJob?.id === id) { currentJob = detail; renderJob(); } }
  } finally { refreshing = false; if (refreshAgain) { refreshAgain = false; scheduleRefresh(); } }
}
const scheduleRefresh = createRefreshScheduler(refresh, error => notice(error.message, true));
async function openJob(id) {
  const job = await api(`/jobs/${id}`);
  if (currentJob?.id !== id) { $("job-activity").replaceChildren(); $("requests").replaceChildren(); scrollPositions.delete("job"); }
  currentJob = job; renderJob(); navigate("job");
}
async function start(input) {
  if (submitting) return; submitting = true; renderState(); notice("");
  try { const job = await api("/jobs", input); await openJob(job.id); await refresh(); }
  catch (error) { await refresh().catch(() => {}); throw error; }
  finally { submitting = false; renderState(); }
}
async function openReport(slug) {
  report = await api(`/reports/${encodeURIComponent(slug)}`);
  $("report-detail").innerHTML = reportView(report, implementationSelection, { prReady: prReady(), busy: busy() }, specSelection); $("report-detail").hidden = false; $("finding-list").hidden = true;
  $("report-detail").querySelector(".back").focus({ preventScroll: true });
}

document.addEventListener("click", protect(async event => {
  const button = event.target.closest("button"); if (!button || button.disabled) return;
  const d = button.dataset;
  if (d.page) { navigate(d.page); if (d.page === "setup") fillSetup(); }
  if (d.job) await openJob(d.job);
  if (d.report) await openReport(d.report);
  if (d.filter) { filter = d.filter; report = null; $("report-detail").hidden = true; $("finding-list").hidden = false; for (const tab of document.querySelectorAll("[data-filter]")) tab.setAttribute("aria-pressed", String(tab === button)); renderState(); }
  if (Object.hasOwn(d, "backFindings")) {
    const slug = report?.slug; report = null; $("report-detail").hidden = true; $("finding-list").hidden = false;
    [...$("finding-list").querySelectorAll("[data-report]")].find(row => row.dataset.report === slug)?.focus({ preventScroll: true });
  }
  if (Object.hasOwn(d, "declineToggle")) { $("decline-form").hidden = !$("decline-form").hidden; if (!$("decline-form").hidden) $("decline-form").elements.reason.focus(); }
  if (d.reportPr) await start({ kind: "pr", source: { kind: "report", value: d.reportPr }, selection: implementationSelection, specSelection });
  if (d.connect) await start({ kind: d.kind, runner: d.connect });
  if (d.refresh) { await api("/connections/refresh", { runner: d.refresh }); await refresh(); }
  if (d.stop) { await api(`/jobs/${d.stop}/stop`, {}); await refresh(); }
  if (Object.hasOwn(d, "rerun")) {
    if (currentJob.scoutScope) {
      scoutControls.set(currentJob.scoutScope.options); selection = currentJob.selection;
      storage.set(`${selectionKey}:scope`, scoutControls.draft()); saveSelection(selection, "scout");
      renderState(); navigate("runs");
      notice("Previous choices loaded. Review the dates and source, then launch. Relative periods move with today.");
    } else await start({ kind: currentJob.kind, source: currentJob.source, selection: currentJob.selection, specSelection: currentJob.kind === "pr" ? currentJob.specSelection || currentJob.selection : undefined });
  }
  if (d.artifact) { const artifact = await api(`/jobs/${currentJob.id}/artifact?key=${encodeURIComponent(d.artifact)}`); $("artifact-title").textContent = artifact.label; $("artifact-body").innerHTML = artifact.html || `<pre>${escape(artifact.body)}</pre>`; $("artifact-dialog").showModal(); }
}));
$("close-artifact").addEventListener("click", () => $("artifact-dialog").close());
$("artifact-dialog").addEventListener("click", event => { if (event.target === $("artifact-dialog")) { const r = event.target.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) event.target.close(); } });

for (const role of ["scout", "spec", "implementation"]) $(role === "scout" ? "model-controls" : `${role}-model-controls`).addEventListener("change", protect(async event => {
  let value = role === "scout" ? selection : role === "spec" ? specSelection : implementationSelection;
  const key = role === "scout" ? selectionKey : `${selectionKey}:${role}`;
  if (event.target.dataset.choice === "runner") {
    const runner = event.target.value, saved = storage.get(`${key}:${runner}`), models = state.roleModels[role][runner];
    const first = role === "spec" ? models.find(row => row.id === (runner === "codex" ? "gpt-5.6-sol" : "claude-opus-5")) : models[0];
    value = validStored(saved, role) ? saved : { runner, model: first.id, effort: role === "spec" ? "high" : first.defaultEffort };
  } else if (event.target.dataset.choice === "model") {
    const model = state.connections[value.runner].models.find(row => row.id === event.target.value);
    const effort = storage.get(`${key}:${model.id}`);
    value = { ...value, model: model.id, effort: model.efforts.includes(effort) ? effort : role === "spec" && model.efforts.includes("high") ? "high" : model.defaultEffort };
  } else value = { ...value, effort: event.target.value };
  if (role === "scout") selection = value; else if (role === "spec") specSelection = value; else implementationSelection = value;
  saveSelection(value, role); renderState();
}));
$("launch-scout").addEventListener("click", protect(() => start({ kind: "scout", selection, scout: scoutControls.value(), expectedRevision: state.workspace.revision })));
$("refresh-connections").addEventListener("click", protect(async () => { await Promise.all(["claude", "codex"].map(runner => api("/connections/refresh", { runner }))); await refresh(); }));
$("setup-form").addEventListener("input", () => { dirtySetup = true; $("draft-context").disabled = true; });
$("permission-mode").addEventListener("change", () => { dirtySetup = true; permissionHelp(); });
$("setup-form").addEventListener("submit", protect(async event => {
  event.preventDefault(); const form = event.target;
  if (!form.reportValidity()) return;
  await start({ kind: "setup", setup: { ...selection, permissionMode: form.elements.permissionMode.value, scout: scoutControls.value(), spec: specSelection, implementation: implementationSelection, expectedRevision: setupRevision, projectId: form.elements.projectId.value, host: form.elements.host.value, context: form.elements.context.value, confirmed: form.elements.confirmed.checked, readModel: form.elements.readModel.value } });
}));
$("view-current-setup").addEventListener("click", protect(async () => {
  await refresh();
  $("artifact-title").textContent = "Current setup on disk";
  $("artifact-body").innerHTML = `<pre>${escape(JSON.stringify(state.workspace.config, null, 2))}</pre><pre>${escape(state.workspace.context)}</pre>`;
  $("artifact-dialog").showModal();
}));
$("load-current-setup").addEventListener("click", protect(async () => {
  await refresh(); dirtySetup = false; fillSetup();
  const config = state.workspace.config;
  scoutControls.set(config.scout); storage.set(`${selectionKey}:scope`, scoutControls.draft());
  if (validStored(config)) selection = { runner: config.runner, model: config.model, effort: config.effort };
  if (validStored(config.spec, "spec")) specSelection = config.spec;
  if (validStored(config.implementation, "implementation")) implementationSelection = config.implementation;
  for (const [role, value] of Object.entries({ scout: selection, spec: specSelection, implementation: implementationSelection })) saveSelection(value, role);
  renderState(); notice("Loaded current setup. Review it before saving.");
}));
$("context-form").addEventListener("submit", protect(async event => { event.preventDefault(); await start({ kind: "context", selection, about: event.target.elements.about.value }); }));
$("issue-form").addEventListener("submit", protect(async event => { event.preventDefault(); await start({ kind: "pr", selection: implementationSelection, specSelection, source: { kind: "issue", value: event.target.elements.issue.value.trim() } }); }));
$("report-detail").addEventListener("submit", protect(async event => {
  if (event.target.id !== "decline-form") return; event.preventDefault();
  await start({ kind: "decline", source: { kind: "report", value: report.slug }, reason: event.target.elements.reason.value }); report = null; $("report-detail").hidden = true; $("finding-list").hidden = false;
}));

async function followEvents() {
  while (true) {
    try {
      const response = await fetch("/api/events", { headers: { "X-Rusubon-Token": token || "" } });
      if (!response.ok) throw new Error("Dashboard connection lost");
      $("stream-label").textContent = "Local connection · live"; $("stream-icon").dataset.complete = "true";
      const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = "";
      while (true) { const { value, done } = await reader.read(); if (done) break; pending += decoder.decode(value, { stream: true }); let at; while ((at = pending.indexOf("\n\n")) >= 0) { const entry = pending.slice(0, at); pending = pending.slice(at + 2); if (entry.startsWith("data:")) scheduleRefresh(); } }
    } catch { /* Reconnect without discarding pending forms or run selection. */ }
    $("stream-label").textContent = "Disconnected · reconnecting"; $("stream-icon").dataset.complete = "false";
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

setInterval(() => {
  if (!state || document.hidden) return;
  for (const element of document.querySelectorAll("[data-duration]")) { const job = state.jobs.find(row => row.id === element.dataset.duration); if (job && !ended(job)) element.textContent = duration(job); }
}, 1000);
// Refresh relative date previews when an open dashboard crosses midnight UTC.
let previewDay = new Date().toISOString().slice(0, 10);
setInterval(() => { const day = new Date().toISOString().slice(0, 10); if (state && day !== previewDay) { previewDay = day; renderState(); if (page === "usage") usage.load(); } }, 30_000);

try {
  await refresh();
  const savedPage = storage.get(`${selectionKey}:page`);
  if (savedPage?.page === "job" && state.jobs.some(job => job.id === savedPage.jobId)) await openJob(savedPage.jobId);
  else if (["runs", "findings", "research", "setup", "usage"].includes(savedPage?.page)) navigate(savedPage.page);
  interactive = true;
  for (const runner of ["claude", "codex"]) api("/connections/refresh", { runner }).catch(error => notice(error.message, true));
  followEvents();
} catch (error) { notice(error.message, true); $("stream-label").textContent = "Not connected"; }
