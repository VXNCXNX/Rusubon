import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { reportSlug } from "./decline.mjs";
import { archiveDir, cwd, reportsDir } from "./paths.mjs";

const RANK = { P1: 0, P2: 1, P3: 2 };

export function parseReport(text, fallbackTitle = "") {
  const title = ((text.match(/^#\s+(.+)/m) || [, fallbackTitle])[1] || "").trim();
  const priority = ((text.match(/^priority:\s*(P[123])\s*$/im) || [])[1] || "").toUpperCase();
  const priorityExplanation = ((text.match(/^priority_explanation:\s*(.+)$/im) || [])[1] || "").trim();
  const actionability = ((text.match(/^actionability:\s*(\S+)/im) || [])[1] || "").trim();
  return { title, priority, priorityExplanation, actionability };
}

export function inboxSlug(path) {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
}

export function formatInboxLine(item) {
  return `${item.priority || "—"}  ${inboxSlug(item.path)}  ${item.title}`;
}

export function listInbox() {
  const dir = reportsDir();
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (!st.isFile()) continue;
    const text = readFileSync(path, "utf8");
    const parsed = parseReport(text, name);
    out.push({ path, mtime: st.mtimeMs, ...parsed });
  }
  return out.sort((a, b) => {
    const ra = RANK[a.priority] ?? 9;
    const rb = RANK[b.priority] ?? 9;
    if (ra !== rb) return ra - rb;
    return b.mtime - a.mtime;
  });
}

export function printInbox(items) {
  if (!items.length) {
    console.log("inbox empty.");
    return;
  }
  for (const item of items) console.log(formatInboxLine(item));
  console.log('rusubon show <slug>   rusubon decline <slug> --why "…"');
}

export function showReport(raw) {
  const slug = reportSlug(raw);
  const open = join(reportsDir(), `${slug}.md`);
  const archived = join(archiveDir(), `${slug}.md`);
  if (existsSync(open)) {
    return { slug, where: "reports", path: open, body: readFileSync(open, "utf8") };
  }
  if (existsSync(archived)) {
    return { slug, where: "archive", path: archived, body: readFileSync(archived, "utf8") };
  }
  throw new Error(`no report '${slug}' in inbox/reports or inbox/archive. rusubon inbox`);
}

export function printShow(report) {
  const root = cwd() + "/";
  const rel = report.path.startsWith(root) ? report.path.slice(root.length) : report.path;
  console.log(`${rel}  (${report.where})\n`);
  console.log(report.body.trimEnd());
}
