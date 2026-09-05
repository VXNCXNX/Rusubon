import { DEFAULT_SCOUT, SCOUT_CHECKS, scoutOptions, scoutWindow, resolveScoutScope, windowLabel } from "/scope.js";
import { escape } from "/views.js";
import { updateMarkup } from "/interface.js";

export function scopeControls(container, saved, onChange) {
  let draft = { ...DEFAULT_SCOUT, ...(saved && typeof saved === "object" ? saved : {}) }, workspace, runner;
  container.innerHTML = `<div class="scope-source"><div><span class="field-label">Data source</span><strong id="scope-source-name"></strong><p class="caption">Official PostHog connection · context from this repository</p></div><button class="text-button" type="button" data-page="setup">Change in Setup</button></div>
    <fieldset class="scope-fields"><legend class="sr-only">Investigation scope</legend>
      <div class="scope-investigation"><div class="scope-target">
      <div class="scope-grid"><label>Period<select id="scout-period"><option value="7d">Last 7 days</option><option value="14d">Last 14 days</option><option value="30d">Last 30 days</option><option value="custom">Custom dates</option></select></label><label>Focus<select id="scout-focus"><option value="all">All confirmed money paths</option><option value="selected">Choose paths</option></select></label></div>
      <div id="scout-custom-dates" class="scope-grid" hidden><label>From (UTC)<input type="date" id="scout-start"></label><label>Through (UTC)<input type="date" id="scout-end"></label></div>
      <p class="caption scope-dates"><span id="scout-window"></span> <span id="scout-baseline"></span></p>
      <div id="scout-paths" class="scope-paths" hidden></div><p id="scout-focus-help" class="caption"></p>
      </div><div class="scope-inspection">
      <fieldset class="scope-checks"><legend>What to inspect</legend><div class="check-grid">${SCOUT_CHECKS.map(row => `<label class="scope-check"><input type="checkbox" value="${row.id}" data-check><span>${escape(row.label)}<small>${escape(row.detail)}</small></span></label>`).join("")}</div></fieldset>
      <p id="scout-history" class="caption"></p><p id="scout-evidence" class="caption"></p>
      </div></div>
      <details class="scope-note"><summary>Add context for this run</summary><label>Additional context<textarea id="scout-note" rows="2" maxlength="2000" placeholder="We changed checkout this week. Focus on address validation."></textarea></label></details>
    </fieldset>`;
  const find = id => container.querySelector(`#${id}`);
  function set(value) {
    draft = { ...DEFAULT_SCOUT, ...value };
    const dates = scoutWindow(DEFAULT_SCOUT);
    find("scout-period").value = draft.period;
    find("scout-start").value = draft.startDate || dates.start.slice(0, 10);
    find("scout-end").value = draft.endDate || new Date(Date.parse(dates.end) - 86_400_000).toISOString().slice(0, 10);
    find("scout-focus").value = draft.focus === "all" ? "all" : "selected";
    find("scout-note").value = typeof draft.note === "string" ? draft.note : "";
    for (const input of container.querySelectorAll("[data-check]")) input.checked = Array.isArray(draft.checks) && draft.checks.includes(input.value);
    if (workspace) update(workspace, runner);
  }
  function read() {
    return { period: find("scout-period").value, startDate: find("scout-start").value, endDate: find("scout-end").value,
      focus: find("scout-focus").value === "all" ? "all" : [...container.querySelectorAll("[data-focus]:checked")].map(n => n.value),
      checks: [...container.querySelectorAll("[data-check]:checked")].map(n => n.value), note: find("scout-note").value };
  }
  function update(w, selectedRunner, busy = false) {
    workspace = w; runner = selectedRunner;
    container.querySelector(".scope-fields").disabled = busy;
    const host = w.config.posthog.host, region = /\beu\b/.test(host) ? "EU" : /\bus\b/.test(host) ? "US" : "region not set";
    find("scope-source-name").textContent = w.config.posthog.projectId ? `PostHog · Project ${w.config.posthog.projectId} · ${region}` : "PostHog · choose a project in Setup";
    find("scout-custom-dates").hidden = draft.period !== "custom";
    const available = w.confirmed ? w.moneyPaths || [] : [], selected = Array.isArray(draft.focus) ? draft.focus : [];
    const paths = [...new Set([...available, ...selected])];
    updateMarkup(find("scout-paths"), paths.map(path => `<label class="scope-path" data-key="${escape(path)}"><input type="checkbox" data-focus value="${escape(path)}" ${selected.includes(path) ? "checked" : ""} ${!available.includes(path) ? "disabled" : ""}><span>${escape(path)}${!available.includes(path) ? " · review in Setup" : ""}</span></label>`).join(""));
    find("scout-paths").hidden = draft.focus === "all";
    find("scout-focus-help").textContent = available.length ? `${available.length} money ${available.length === 1 ? "path" : "paths"} from your confirmed context. Intentional friction and exclusions always apply.` : "Add paths under Money paths in Setup and confirm the context.";
    find("scout-evidence").textContent = selectedRunner === "claude" ? "Counts come from events. Claude also reviews qualified session evidence for the selected checks." : "Counts come from events. Codex runs SQL analysis only; it does not perform session review or file P2 money-path findings.";
    let scope, window, error = "";
    try {
      window = scoutWindow(draft);
      find("scout-window").textContent = `${windowLabel(window)}. Today excluded.`;
      find("scout-baseline").textContent = `Baseline: ${window.baselineStart.slice(0, 10)} to ${new Date(Date.parse(window.start) - 86_400_000).toISOString().slice(0, 10)}.`;
      find("scout-history").textContent = Array.isArray(draft.checks) && draft.checks.some(id => ["coverage", "replay"].includes(id)) ? `Coverage and replay checks may read diagnostic history from ${window.historyStart.slice(0, 10)}. Findings stay within the selected period.` : "";
      scope = resolveScoutScope(draft, w);
    } catch (cause) { error = cause.message; }
    if (!window) for (const id of ["scout-window", "scout-baseline", "scout-history"]) find(id).textContent = "";
    return { scope, error };
  }
  container.addEventListener("input", event => {
    if (event.target.id === "scout-focus" && event.target.value === "selected") {
      draft.focus = workspace?.moneyPaths?.slice() || [];
      update(workspace, runner);
    }
    draft = read();
    onChange(draft);
  });
  set(draft);
  return { update, set, value: () => scoutOptions(read()), draft: () => read() };
}
