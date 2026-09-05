import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "./paths.mjs";
import { pathMatches, signalTypes } from "./scout-scope.mjs";

export const READ_MAX_SESSIONS = 100;
export const READ_MAX_MS = 45 * 60 * 1000;
export const READ_BATCH = 10;
export const SESSION_CURSOR_KEY = "dedupe/friction-session-cursor";

export function candidatesRel(skillName, day = new Date()) {
  return `.rusubon/runs/${day.toISOString().slice(0, 10)}-${skillName}-candidates.json`;
}

export function candidatesPath(skillName, day = new Date()) {
  return join(cwd(), candidatesRel(skillName, day));
}

export function parseCandidates(raw) {
  const data = typeof raw === "string" ? JSON.parse(raw) : raw || {};
  const ids = [];
  for (const row of Array.isArray(data.ids) ? data.ids : []) {
    const sessionId = String(row.sessionId || row.id || "").trim();
    if (!sessionId) continue;
    ids.push({
      sessionId,
      signals: Number(row.signals) || 0,
      paths: Array.isArray(row.paths) ? row.paths.map(String) : [],
      lastSignalAt: String(row.lastSignalAt || ""),
    });
  }
  ids.sort((a, b) => b.signals - a.signals);
  return { ids, windowDays: Number(data.windowDays) || 7 };
}

export function loadCandidates(skillName, day = new Date(), overrideRel) {
  const path = overrideRel ? join(cwd(), overrideRel) : candidatesPath(skillName, day);
  if (!existsSync(path)) return { ids: [], windowDays: 7, path };
  try {
    return { ...parseCandidates(readFileSync(path, "utf8")), path };
  } catch {
    return { ids: [], windowDays: 7, path };
  }
}

/** Scoped runs fail visibly rather than quietly reviewing unrelated sessions. */
export function scopedCandidates(raw, scope) {
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!data || data.scopeId !== scope.id || !Array.isArray(data.ids) || data.ids.length > 1000) throw new Error("Scout candidates do not match this run's investigation scope.");
  const allowed = signalTypes(scope.options.checks), ids = [], seen = new Set();
  for (const row of data.ids) {
    if (!row || typeof row !== "object") throw new Error("Scout produced an invalid session candidate.");
    const at = typeof row.lastSignalAt === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(row.lastSignalAt) ? Date.parse(row.lastSignalAt) : NaN;
    if (typeof row.sessionId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(row.sessionId) || !Number.isFinite(at) || at < Date.parse(scope.window.start) || at >= Date.parse(scope.window.end)
      || !Array.isArray(row.paths) || !row.paths.length || row.paths.some(path => typeof path !== "string" || !pathMatches(path, scope.paths))
      || !Array.isArray(row.signalTypes) || !row.signalTypes.length || row.signalTypes.some(type => !allowed.includes(type))
      || !Number.isFinite(row.signals) || row.signals <= 0) throw new Error("Scout produced a candidate outside the selected dates, paths, or checks.");
    if (!seen.has(row.sessionId)) { seen.add(row.sessionId); ids.push({ sessionId: row.sessionId, signals: row.signals, paths: row.paths, lastSignalAt: row.lastSignalAt, signalTypes: row.signalTypes }); }
  }
  ids.sort((a, b) => b.signals - a.signals);
  return { scopeId: scope.id, windowDays: scope.window.days, ids };
}

export function shouldRunPhase2(config, candidates, closeBody) {
  if ((config?.runner || "claude") !== "claude") return false;
  if (!candidates?.ids?.length) return false;
  if (closeBody && String(closeBody).trimStart().toLowerCase().startsWith("no posthog tools")) {
    return false;
  }
  return true;
}

export function closeOutBody(skillName, day = new Date(), overrideRel) {
  const rel = overrideRel || `.rusubon/runs/${day.toISOString().slice(0, 10)}-${skillName}.md`;
  const path = join(cwd(), rel);
  if (!existsSync(path)) return { rel, path, body: null };
  return { rel, path, body: readFileSync(path, "utf8") };
}
