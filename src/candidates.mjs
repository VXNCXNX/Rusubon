import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd, runsDir } from "./paths.mjs";

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

export function loadCandidates(skillName, day = new Date()) {
  const path = candidatesPath(skillName, day);
  if (!existsSync(path)) return { ids: [], windowDays: 7, path };
  try {
    return { ...parseCandidates(readFileSync(path, "utf8")), path };
  } catch {
    return { ids: [], windowDays: 7, path };
  }
}

export function shouldRunPhase2(config, candidates, closeBody) {
  if ((config?.runner || "claude") !== "claude") return false;
  if (!candidates?.ids?.length) return false;
  if (closeBody && String(closeBody).trimStart().toLowerCase().startsWith("no posthog tools")) {
    return false;
  }
  return true;
}

export function closeOutBody(skillName, day = new Date()) {
  const rel = `.rusubon/runs/${day.toISOString().slice(0, 10)}-${skillName}.md`;
  const path = join(runsDir(), `${day.toISOString().slice(0, 10)}-${skillName}.md`);
  if (!existsSync(path)) return { rel, path, body: null };
  return { rel, path, body: readFileSync(path, "utf8") };
}
