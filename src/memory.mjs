import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { FRICTION_INDEX_PREFIXES, INDEX_CAP, MEMORY_PREFIXES, memoryDir } from "./paths.mjs";

const KEY = /^(pattern|noise|addressed|dedupe|not-in-use|report)\/([a-z0-9][a-z0-9-]*)$/;

export function parseKey(raw) {
  const key = String(raw || "").trim();
  const m = key.match(KEY);
  if (!m) {
    throw new Error(
      `bad memory key '${raw}'. use prefix/slug with prefix in ${MEMORY_PREFIXES.join(", ")} and slug [a-z0-9-]`,
    );
  }
  if (/\d{4}-\d{2}-\d{2}/.test(m[2])) {
    throw new Error(`bad memory key '${raw}'. dates go in the body, not the slug`);
  }
  return { prefix: m[1], slug: m[2], key: `${m[1]}/${m[2]}` };
}

export function memoryFile(key) {
  const { prefix, slug } = typeof key === "string" ? parseKey(key) : key;
  const root = memoryDir();
  const path = resolve(root, prefix, `${slug}.md`);
  if (relative(root, path).startsWith("..") || relative(root, path).includes("..")) {
    throw new Error("memory path escaped .rusubon/memory");
  }
  return path;
}

export function remember(rawKey, content) {
  const parsed = parseKey(rawKey);
  const body = String(content || "").trim();
  if (!body) throw new Error("remember needs content");
  const path = memoryFile(parsed);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body.endsWith("\n") ? body : body + "\n");
  return { ...parsed, path };
}

export function firstLine(text) {
  const line = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  return (line || "").slice(0, 160);
}

export function listMemory(prefixes = MEMORY_PREFIXES) {
  const root = memoryDir();
  if (!existsSync(root)) return [];
  const out = [];
  for (const prefix of prefixes) {
    const dir = join(root, prefix);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      const path = join(dir, name);
      const slug = name.slice(0, -3);
      const text = readFileSync(path, "utf8");
      out.push({ key: `${prefix}/${slug}`, prefix, slug, path, summary: firstLine(text) });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export function formatIndex(skillName, cap = INDEX_CAP) {
  let entries = listMemory(MEMORY_PREFIXES);
  if (entries.length > cap && skillName === "friction") {
    entries = listMemory(FRICTION_INDEX_PREFIXES);
  }
  let clipped = false;
  if (entries.length > cap) {
    entries = entries.slice(0, cap);
    clipped = true;
  }
  if (!entries.length) return "(empty)";
  const lines = entries.map((e) => `- ${e.key} — ${e.summary || "(empty)"}`);
  if (clipped) lines.push(`- … clipped to ${cap} keys`);
  return lines.join("\n");
}
