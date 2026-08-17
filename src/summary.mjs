import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseReport } from "./inbox.mjs";
import { cwd, memoryDir, reportsDir, runsDir } from "./paths.mjs";

const SKIP = new Set(["last-prompt.md"]);

export function closeOutRel(skillName, day = new Date()) {
  return `.rusubon/runs/${day.toISOString().slice(0, 10)}-${skillName}.md`;
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function walkMd(root) {
  if (!existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) stack.push(path);
      else if (name.endsWith(".md")) {
        out.push({
          path,
          rel: relative(root, path),
          sig: `${st.size}:${st.mtimeMs}`,
        });
      }
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export function snapshotState() {
  return {
    reports: Object.fromEntries(walkMd(reportsDir()).map((f) => [f.rel, f.sig])),
    memory: Object.fromEntries(walkMd(memoryDir()).map((f) => [f.rel, f.sig])),
  };
}

function diffKeys(before, after) {
  const out = [];
  for (const [rel, sig] of Object.entries(after)) {
    const key = rel.replace(/\.md$/, "");
    if (!(rel in before)) out.push({ key, kind: "new" });
    else if (before[rel] !== sig) out.push({ key, kind: "updated" });
  }
  return out;
}

function firstUsefulLine(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    return t;
  }
  return "";
}

export function mcpFromCloseOut(body) {
  if (body == null) return "unknown";
  const start = String(body).trimStart();
  if (start.toLowerCase().startsWith("no posthog tools")) return "missing";
  return "ok";
}

export function summarizeRun({ skillName, startedAt, before, now = Date.now() }) {
  const rel = closeOutRel(skillName);
  const abs = join(cwd(), rel);
  const closeBody = existsSync(abs) ? readFileSync(abs, "utf8") : null;
  const after = snapshotState();
  const reports = diffKeys(before.reports, after.reports);
  const memory = diffKeys(before.memory, after.memory);
  return {
    skill: skillName,
    duration: formatDuration(now - startedAt),
    mcp: mcpFromCloseOut(closeBody),
    closeOut: closeBody == null ? null : rel,
    closeLine: closeBody ? firstUsefulLine(closeBody) : "",
    reports,
    memory,
  };
}

export function formatRunSummary(summary) {
  const mem =
    summary.memory.length === 0
      ? "(none)"
      : summary.memory.map((m) => `${m.key} (${m.kind})`).join(", ");
  const lines = [
    `${summary.skill}  ${summary.duration}  mcp=${summary.mcp}`,
    `reports   ${summary.reports.length}`,
  ];
  for (const r of summary.reports) {
    const path = join(reportsDir(), `${r.key}.md`);
    const pri = existsSync(path) ? parseReport(readFileSync(path, "utf8"), r.key).priority : "";
    lines.push(`          ${pri || "—"}  ${r.key} (${r.kind})`);
  }
  lines.push(`memory    ${mem}`);
  if (summary.closeOut) {
    lines.push(`close-out ${summary.closeOut}`);
    if (summary.closeLine) lines.push(`          ${summary.closeLine}`);
  } else {
    lines.push(`close-out missing — scout did not write ${closeOutRel(summary.skill)}`);
  }
  return lines.join("\n");
}

export function printRunSummary(summary) {
  console.log("");
  console.log(formatRunSummary(summary));
}
