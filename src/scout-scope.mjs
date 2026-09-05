// Shared by the dashboard and runner. Dates are complete UTC days, with an
// exclusive end boundary, so both phases use the same reproducible window.
const DAY = 86_400_000;
export const SCOUT_CHECKS = [
  { id: "clicks", label: "Rage & dead clicks", detail: "Click events, then qualified session evidence." },
  { id: "errors", label: "Errors & failed requests", detail: "Exception events and recorded session features." },
  { id: "coverage", label: "Recording coverage", detail: "Pageviews compared with recording metadata." },
  { id: "replay", label: "Existing replay analysis", detail: "Stored replay signals and summaries, when available." },
];
export const DEFAULT_SCOUT = { period: "7d", focus: "all", checks: SCOUT_CHECKS.map(row => row.id), note: "" };

export function signalTypes(checks) {
  return [...(checks.includes("clicks") ? ["$rageclick", "$dead_click"] : []), ...(checks.includes("errors") ? ["$exception", "session_features"] : []), ...(checks.includes("replay") ? ["$recording_observed"] : [])];
}

export function moneyPaths(context) {
  const lines = String(context || "").split(/\r?\n/), paths = new Set();
  let level = 0;
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+)/);
    if (heading) {
      if (/^money paths\b/i.test(heading[2])) level = heading[1].length;
      else if (level && heading[1].length <= level) break;
      continue;
    }
    if (!level) continue;
    for (const match of line.matchAll(/https?:\/\/[^\s<>"'`)\]]+|(?<![\w/])\/(?:[a-zA-Z0-9:*][^\s<>"'`)\]]*)?/g)) {
      const path = match[0].replace(/[.,;]+$/, "").replace(/[?#].*$/, "");
      // A prose separator such as "signup / billing" must not select every URL.
      if (path === "/" && !/^\s*(?:[-*+]\s+|\d+\.\s+)?\/?\s*$/.test(line) && !line.includes("`/`")) continue;
      if (path.length > 300 || path.startsWith("//")) continue;
      if (path.startsWith("http")) { try { const url = new URL(path); if (url.username || url.password) continue; } catch { continue; } }
      paths.add(path);
    }
  }
  return [...paths].slice(0, 100);
}

export function scoutOptions(input = DEFAULT_SCOUT) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Choose the scout's investigation settings.");
  const { period = "7d", focus = "all", checks = DEFAULT_SCOUT.checks, note = "" } = input;
  if (!["7d", "14d", "30d", "custom"].includes(period)) throw new Error("Choose 7, 14, or 30 days, or a custom period.");
  if (focus !== "all" && (!Array.isArray(focus) || !focus.length || focus.length > 100 || focus.some(path => typeof path !== "string" || path.length > 300))) throw new Error("Choose at least one confirmed money path.");
  if (!Array.isArray(checks) || !checks.length || checks.some(id => !SCOUT_CHECKS.some(row => row.id === id))) throw new Error("Choose at least one supported check to inspect.");
  if (typeof note !== "string" || note.length > 2000) throw new Error("Keep additional context to 2,000 characters.");
  return { period, ...(period === "custom" ? { startDate: input.startDate, endDate: input.endDate } : {}), focus: focus === "all" ? "all" : [...new Set(focus)], checks: [...new Set(checks)], note: note.trim() };
}

function utcDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Choose both custom dates.");
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new Error("Enter valid calendar dates.");
  return ms;
}

export function scoutWindow(input, now = new Date()) {
  const options = scoutOptions(input), today = utcDate(new Date(now).toISOString().slice(0, 10));
  const end = options.period === "custom" ? utcDate(options.endDate) + DAY : today;
  const start = options.period === "custom" ? utcDate(options.startDate) : end - Number.parseInt(options.period, 10) * DAY;
  const days = (end - start) / DAY;
  if (days < 1 || days > 90) throw new Error("Choose a period between 1 and 90 days, with the start before the end.");
  if (end > today) throw new Error("Choose completed UTC days. The latest end date is yesterday.");
  const iso = ms => new Date(ms).toISOString();
  return { start: iso(start), end: iso(end), baselineStart: iso(start - days * DAY), historyStart: iso(end - Math.max(30, days * 2) * DAY), days, timezone: "UTC" };
}

export function resolveScoutScope(input, workspace, now = new Date()) {
  const options = scoutOptions(input), window = scoutWindow(options, now);
  if (!workspace.confirmed) throw new Error("Confirm your product context in Setup before scouting.");
  const available = moneyPaths(workspace.context);
  if (!available.length) throw new Error("Add URLs or paths under Money paths in Setup, then confirm your context.");
  const paths = options.focus === "all" ? available : options.focus;
  if (paths.some(path => !available.includes(path))) throw new Error("A selected path is no longer in your confirmed context. Review the focus before launching.");
  const posthog = workspace.config?.posthog || workspace.posthog;
  const region = ({ us: "us", eu: "eu", "https://us.posthog.com": "us", "https://eu.posthog.com": "eu" })[posthog?.host];
  if (!/^\d+$/.test(String(posthog?.projectId || "")) || !region) throw new Error("Choose a PostHog project and region in Setup.");
  return { version: 1, options, window, paths, source: { provider: "posthog", projectId: String(posthog.projectId), region }, context: workspace.context, ...(workspace.revision ? { revision: workspace.revision } : {}) };
}

export function windowLabel(window) {
  const endDate = new Date(Date.parse(window.end) - DAY).toISOString().slice(0, 10);
  return `${window.start.slice(0, 10)} to ${endDate} · UTC`;
}

export function pathPattern(value) {
  let host = "", path = value;
  if (/^https?:\/\//.test(value)) { const url = new URL(value); host = url.host; path = url.pathname; }
  const pieces = path.replace(/\/$/, "").split("/").map(part => part === "*" ? ".*" : /^:[\w]+$/.test(part) ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return { host, pattern: `^${pieces.join("/")}(?:/|$)` };
}

export function pathMatches(candidate, allowed) {
  let path = candidate, host = "";
  if (/^https?:\/\//.test(candidate)) { try { const url = new URL(candidate); path = url.pathname; host = url.host; } catch { return false; } }
  path = path.replace(/[?#].*$/, "");
  return allowed.some(value => { const rule = pathPattern(value); return (!rule.host || rule.host === host) && new RegExp(rule.pattern).test(path); });
}
