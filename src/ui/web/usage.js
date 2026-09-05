import { escape, modelLabel } from "/views.js";
import { updateMarkup } from "/interface.js";

const names = { claude: "Claude Code", codex: "Codex" };
const number = value => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(value);
const money = value => value === null ? "Unavailable" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2 }).format(value);
const date = day => new Date(`${day}T00:00:00Z`).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
const cost = row => `${money(row.cost)}${row.unpricedTokens && row.pricedTokens ? "+" : ""}`;
const dot = runner => `<span class="usage-dot usage-${runner}" aria-hidden="true"></span>`;
const fields = { input: "Input", output: "Output", cacheRead: "Cache read", cacheWrite: "Cache write / 5 min", cacheWrite1h: "Cache write / 1 hour" };

function chart(data, metric) {
  const compact = matchMedia("(max-width: 760px)").matches;
  const width = compact ? 360 : 760, height = compact ? 250 : 280, left = compact ? 48 : 58, right = 12, top = 18, bottom = 34;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const value = row => metric === "cost" ? row.cost : row.tokens.total;
  const format = metric === "cost" ? money : number;
  const max = Math.max(1e-6, ...data.daily.flatMap(day => data.providers.map(p => value(day.providers[p.key]) || 0)));
  const ceiling = metric === "cost" ? Math.max(0.01, Math.ceil(max * 100) / 100) : Math.max(1, Math.ceil(max));
  const x = i => left + i / Math.max(1, data.daily.length - 1) * plotWidth;
  const y = v => top + plotHeight * (1 - v / ceiling);
  const grid = [0, 0.5, 1].map(f => `<g><line x1="${left}" x2="${width - right}" y1="${y(ceiling * f)}" y2="${y(ceiling * f)}" class="usage-grid"/><text x="${left - 12}" y="${y(ceiling * f) + 4}" text-anchor="end">${format(ceiling * f)}</text></g>`).join("");
  const series = data.providers.map(provider => {
    const segments = []; let segment = [];
    data.daily.forEach((day, i) => {
      const row = day.providers[provider.key];
      // A missing price is a gap, not an invented zero.
      if (metric === "cost" && row.unpricedTokens) { if (segment.length) segments.push(segment); segment = []; }
      else segment.push([x(i), y(value(row) || 0)]);
    });
    if (segment.length) segments.push(segment);
    return `<g class="usage-${provider.key}">${segments.map(points => {
      const path = points.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(2)},${py.toFixed(2)}`).join(" ");
      return `<path d="${path} L${points.at(-1)[0]},${y(0)} L${points[0][0]},${y(0)} Z" class="usage-area"/><path d="${path}" class="usage-line"/>${points.length === 1 ? `<circle cx="${points[0][0]}" cy="${points[0][1]}" r="3" fill="currentColor"/>` : ""}`;
    }).join("")}</g>`;
  }).join("");
  const labels = [0, Math.floor((data.daily.length - 1) / 2), data.daily.length - 1].map(i => `<text x="${x(i)}" y="${height - 8}" text-anchor="${i === 0 ? "start" : i === data.daily.length - 1 ? "end" : "middle"}">${date(data.daily[i].key)}</text>`).join("");
  const targets = data.daily.map((day, i) => `<rect data-usage-day="${i}" x="${Math.max(left, x(i) - plotWidth / (data.daily.length - 1) / 2)}" y="${top}" width="${plotWidth / (data.daily.length - 1)}" height="${plotHeight}" tabindex="${i === data.daily.length - 1 ? 0 : -1}" role="button" aria-label="${date(day.key)}: ${escape(cost(day))} API estimate, ${number(day.tokens.total)} tokens" class="usage-chart-target"/>`).join("");
  return `<svg class="usage-chart" viewBox="0 0 ${width} ${height}" role="group" aria-label="Daily ${metric === "cost" ? "API cost estimate" : "tokens"} by agent. Use arrow keys to explore days.">${grid}${series}${labels}${targets}</svg>`;
}

function breakdown(data, mode) {
  const rows = mode === "model" ? data.models : data.daily.filter(day => day.runs).toReversed();
  return `<div class="usage-table-wrap"><table class="usage-table"><caption class="sr-only">Usage by ${mode}, dates in UTC</caption><thead><tr><th scope="col">${mode === "model" ? "Model" : "Day (UTC)"}</th><th scope="col">Runs</th><th scope="col">Tokens</th><th scope="col">Token share</th><th scope="col">API estimate</th></tr></thead><tbody>${rows.map(row => `<tr data-key="${escape(`${row.runner || "day"}:${row.key}`)}"><th scope="row">${mode === "model" ? `${dot(row.runner)}${escape(modelLabel(row.key))}` : date(row.key)}</th><td>${row.runs}</td><td title="${row.tokens.total.toLocaleString("en")} tokens">${number(row.tokens.total)}</td><td>${data.total.tokens.total ? (row.tokens.total / data.total.tokens.total * 100).toFixed(1) : "0"}%</td><td>${cost(row)}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">No reported usage in this period.</td></tr>`}</tbody></table></div>`;
}

function overview(data, metric, mode) {
  const t = data.total;
  if (!t.runs) return `<div class="usage-empty panel"><span class="usage-empty-icon" aria-hidden="true">↗</span><h2>No usage reported yet</h2><p>Launch a scout from Runs. Its recorded tokens and API estimate will appear here.</p>${data.missingRuns ? `<p class="caption">${data.missingRuns} ${data.missingRuns === 1 ? "run has" : "runs have"} no usage counters for this selection. That does not mean they were free.</p>` : ""}<button type="button" class="button primary" data-page="runs">Go to Runs</button></div>`;
  const partial = t.unpricedTokens || data.missingRuns || data.partialRuns;
  return `<div class="usage-overview" data-key="usage-overview"><div class="usage-summary"><p class="eyebrow">${t.unpricedTokens ? "Known API estimate" : "API estimate"}</p><div class="usage-amount">${cost(t)}</div><p class="caption">${t.runs} ${t.runs === 1 ? "run" : "runs"} with usage · ${number(t.tokens.total)} tokens</p><div class="usage-providers">${data.providers.map(row => `<div class="usage-provider" data-key="${row.key}"><div>${dot(row.key)}<span>${names[row.key]}</span><strong>${cost(row)}</strong></div><p class="caption">${row.runs} ${row.runs === 1 ? "run" : "runs"} · ${number(row.tokens.total)} tokens</p></div>`).join("")}</div></div><div class="usage-plot"><div class="section-title"><h2>Daily ${metric === "cost" ? "cost" : "tokens"}</h2><div class="tabs usage-tabs" aria-label="Chart metric"><button type="button" data-usage-metric="cost" aria-pressed="${metric === "cost"}">Cost</button><button type="button" data-usage-metric="tokens" aria-pressed="${metric === "tokens"}">Tokens</button></div></div>${chart(data, metric)}<p id="usage-chart-detail" class="caption usage-chart-detail" aria-live="polite">Explore a day on the chart. Dates are UTC.</p></div></div>
    ${partial ? `<p class="usage-coverage" role="status">${[t.unpricedTokens ? `${number(t.unpricedTokens)} tokens have no reliable cost. A + marks a partial estimate.` : "", data.missingRuns ? `${data.missingRuns} additional ${data.missingRuns === 1 ? "run has" : "runs have"} no usage counters.` : "", data.partialRuns ? `${data.partialRuns} ${data.partialRuns === 1 ? "run has" : "runs have"} incomplete usage coverage.` : ""].filter(Boolean).join(" ")}</p>` : ""}
    <div class="usage-totals" aria-label="Token totals">${[["Processed tokens", t.tokens.total], ["Uncached input", t.tokens.input], ["Cache read", t.tokens.cacheRead], ["Cache write", t.tokens.cacheWrite], ["Output", t.tokens.output]].map(([label, value]) => `<div><p class="caption">${label}</p><strong title="${value.toLocaleString("en")}">${number(value)}</strong></div>`).join("")}</div><div class="section-title usage-breakdown-heading"><h2>Breakdown</h2><div class="tabs usage-tabs" aria-label="Breakdown grouping"><button type="button" data-usage-breakdown="model" aria-pressed="${mode === "model"}">Model</button><button type="button" data-usage-breakdown="day" aria-pressed="${mode === "day"}">Day</button></div></div>${breakdown(data, mode)}`;
}

export function usagePage(root, api) {
  let data, request = 0, days = 30, runner = "all", metric = "cost", mode = "model", dirty = false, selectedRate, pricingRevision;
  root.innerHTML = `<div class="heading usage-heading"><div><div class="eyebrow">A clear view of your agents</div><h1 id="usage-title">Usage, without the guesswork.</h1><p>Rusubon dashboard runs in this repository.</p></div><div class="usage-filters"><label><span class="sr-only">Usage agent</span><select id="usage-runner"><option value="all">All agents</option><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label><label><span class="sr-only">Usage period</span><select id="usage-days"><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option></select></label></div></div><div id="usage-error" class="notice error" role="status" hidden></div><div id="usage-content" aria-busy="true"><p class="caption">Reading local usage…</p></div><details class="usage-method"><summary>How estimates work & model rates</summary><p>Dollar amounts are API estimates, not your subscription bill. Claude uses its reported model costs when available. Otherwise we use the rates below at Standard API pricing. Tool fees, Fast mode, and provider-specific discounts may differ.</p><p>Cache reads and writes are separate from ordinary input. Reasoning is already included in output. Claude reports at the end of a phase, including delegated work when available. Codex reports thread usage during a run. Missing counters or prices stay unavailable. Terminal-only CLI runs are not recorded here.</p><div id="usage-pricing"></div></details>`;
  const content = root.querySelector("#usage-content"), errorBox = root.querySelector("#usage-error"), pricing = root.querySelector("#usage-pricing");
  const showError = text => { errorBox.textContent = text; errorBox.hidden = !text; };
  function render() { if (data) updateMarkup(content, overview(data, metric, mode)); }
  matchMedia("(max-width: 760px)").addEventListener("change", render);
  function renderPricing() {
    if (!data || dirty) return;
    const rates = [...data.pricing.rates];
    for (const row of data.models) if (!rates.some(rate => rate.runner === row.runner && rate.model === row.key)) rates.push({ runner: row.runner, model: row.key });
    selectedRate ||= `${rates[0].runner}:${rates[0].model}`;
    const rate = rates.find(row => `${row.runner}:${row.model}` === selectedRate) || rates[0];
    selectedRate = `${rate.runner}:${rate.model}`;
    pricingRevision = data.pricing.revision;
    updateMarkup(pricing, `<form id="usage-rate-form"><div class="usage-rate-heading"><label>Model<select id="usage-rate-model">${rates.map(row => `<option value="${escape(`${row.runner}:${row.model}`)}" ${row === rate ? "selected" : ""}>${escape(modelLabel(row.model))} · ${names[row.runner]}</option>`).join("")}</select></label><p class="caption">USD per 1 million tokens. ${rate.custom ? "Custom rates saved for this repository." : `Catalog checked ${data.pricing.checkedAt}.`} ${rate.source ? `<a href="${escape(rate.source)}" target="_blank" rel="noopener noreferrer">Official pricing ↗</a>` : "No catalog price for this model."}</p></div><div class="usage-rate-fields">${Object.entries(fields).map(([key, label]) => `<label>${label}<input type="number" name="${key}" min="0" max="100000" step="any" ${key === "cacheWrite1h" ? rate.runner === "codex" ? "disabled" : "" : "required"} value="${rate[key] ?? ""}" placeholder="${key === "cacheWrite1h" ? "Not available" : "Rate"}"></label>`).join("")}</div><p class="caption">Overrides apply when the runner has no reliable cost. ${rate.longContext ? "Prompts above 272K input tokens use 2× input/cache rates and 1.5× output." : "Claude cache-write estimates require the 5-minute / 1-hour token split."}</p><div class="usage-rate-actions"><button type="submit" class="button">Save local rates</button>${rate.custom ? '<button type="button" class="button" data-usage-reset>Reset rates</button>' : ""}<span id="usage-rate-status" class="caption" role="status"></span></div></form>`);
    for (const key of Object.keys(fields)) pricing.querySelector("form").elements[key].value = rate[key] ?? "";
  }
  async function load() {
    const id = ++request; content.setAttribute("aria-busy", "true");
    try { const next = await api(`/usage?days=${days}&runner=${runner}`); if (id !== request) return; data = next; showError(""); render(); renderPricing(); }
    catch (error) { if (id === request) { showError(`${error.message}${data ? ` Showing the last loaded ${data.days}-day view for ${names[data.runner] || "all agents"}.` : ""}`); if (!data) content.innerHTML = '<button type="button" class="button" data-usage-retry>Retry loading usage</button>'; } }
    finally { if (id === request) content.setAttribute("aria-busy", "false"); }
  }
  function inspect(index) {
    const day = data?.daily[index]; if (!day) return;
    const detail = root.querySelector("#usage-chart-detail");
    if (detail) detail.textContent = `${date(day.key)} · ${data.providers.map(p => `${names[p.key]} ${metric === "cost" ? cost(day.providers[p.key]) : `${number(day.providers[p.key].tokens.total)} tokens`}`).join(" · ")}`;
  }
  root.addEventListener("pointerover", event => { const target = event.target.closest("[data-usage-day]"); if (target) inspect(Number(target.dataset.usageDay)); });
  root.addEventListener("focusin", event => { if (event.target.hasAttribute("data-usage-day")) inspect(Number(event.target.dataset.usageDay)); });
  root.addEventListener("keydown", event => {
    const targets = [...root.querySelectorAll("[data-usage-day]")], index = targets.indexOf(event.target);
    if (index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? targets.length - 1 : Math.max(0, Math.min(targets.length - 1, index + (event.key === "ArrowLeft" ? -1 : 1)));
    targets.forEach((target, i) => target.setAttribute("tabindex", i === next ? "0" : "-1")); targets[next].focus();
  });
  root.addEventListener("change", event => {
    if (event.target.id === "usage-days") { days = Number(event.target.value); load(); }
    if (event.target.id === "usage-runner") { runner = event.target.value; load(); }
    if (event.target.id === "usage-rate-model") { selectedRate = event.target.value; dirty = false; renderPricing(); }
  });
  pricing.addEventListener("input", event => { if (event.target.matches("input")) dirty = true; });
  async function saveRates(reset = false) {
    const form = pricing.querySelector("form"); if (!reset && !form.reportValidity()) return;
    const split = selectedRate.indexOf(":"), runner = selectedRate.slice(0, split), model = selectedRate.slice(split + 1);
    const values = Object.fromEntries(Object.keys(fields).map(key => [key, form.elements[key].value === "" ? null : Number(form.elements[key].value)]));
    const button = form.querySelector('[type="submit"]'); button.disabled = true;
    try { await api("/usage/rates", { runner, model, ...values, reset, revision: pricingRevision }); dirty = false; await load(); pricing.querySelector("#usage-rate-status").textContent = reset ? "Catalog rates restored." : "Saved locally."; }
    catch (error) { showError(error.message); }
    finally { button.disabled = false; }
  }
  pricing.addEventListener("submit", event => { event.preventDefault(); saveRates(); });
  root.addEventListener("click", event => {
    const target = event.target.closest("button"); if (!target) return;
    if (target.dataset.usageMetric) { metric = target.dataset.usageMetric; render(); }
    if (target.dataset.usageBreakdown) { mode = target.dataset.usageBreakdown; render(); }
    if (target.hasAttribute("data-usage-retry")) load();
    if (target.hasAttribute("data-usage-reset")) saveRates(true);
  });
  return { load };
}
