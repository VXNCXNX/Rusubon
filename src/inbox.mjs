import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { reportSlug } from "./decline.mjs";
import { archiveDir, cwd, reportsDir } from "./paths.mjs";

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
    const title = (text.match(/^#\s+(.+)/m) || [, name])[1];
    out.push({ path, title, mtime: st.mtimeMs });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function printInbox(items) {
  if (!items.length) {
    console.log("inbox empty.");
    return;
  }
  const root = cwd() + "/";
  for (const item of items) {
    const rel = item.path.startsWith(root) ? item.path.slice(root.length) : item.path;
    const slug = item.path.slice(item.path.lastIndexOf("/") + 1).replace(/\.md$/, "");
    console.log(`${rel}\n  ${item.title}\n  rusubon show ${slug}`);
  }
  console.log("rusubon decline <slug> --why \"…\"  to archive");
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
