import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { remember } from "./memory.mjs";
import { archiveDir, reportsDir } from "./paths.mjs";

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export function reportSlug(raw) {
  let s = String(raw || "").trim().replace(/\\/g, "/");
  if (s.includes("/")) s = s.slice(s.lastIndexOf("/") + 1);
  if (s.endsWith(".md")) s = s.slice(0, -3);
  if (!SLUG.test(s)) {
    throw new Error(`bad report slug '${raw}'. use [a-z0-9][a-z0-9-]*`);
  }
  return s;
}

export function decline(rawSlug, why) {
  const slug = reportSlug(rawSlug);
  const reason = String(why || "").trim();
  if (!reason) throw new Error("decline needs --why");

  const src = join(reportsDir(), `${slug}.md`);
  const dest = join(archiveDir(), `${slug}.md`);
  if (!existsSync(src)) {
    throw new Error(`no open report '${slug}' in .rusubon/inbox/reports`);
  }

  mkdirSync(archiveDir(), { recursive: true });
  if (existsSync(dest)) unlinkSync(dest);
  renameSync(src, dest);

  const today = new Date().toISOString().slice(0, 10);
  const mem = remember(
    `noise/${slug}`,
    `${reason}\n\nDeclined ${today}. If this shape returns unchanged, skip. Escalate only if volume or path changed.\n`,
  );

  return { slug, archive: dest, memory: mem.path };
}
