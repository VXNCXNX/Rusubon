import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { parseReport } from "../inbox.mjs";
import { PLACEHOLDER, contextDraftPending } from "../context.mjs";
import { missingSections, sealDraft } from "../context-draft.mjs";
import { safeText, safeValue } from "./process.mjs";
import { DEFAULT_SPEC_SELECTION, validateSavedSelection } from "./models.mjs";
import { DEFAULT_SCOUT, moneyPaths, scoutOptions, scoutWindow } from "../scout-scope.mjs";

export function localPath(repo, path) {
  if (typeof path !== "string" || isAbsolute(path) || path.includes("\0")) throw new Error("Invalid workspace path");
  const full = resolve(repo, path), rel = relative(repo, full);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Path escapes the repository");
  let cursor = repo;
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part);
    try { if (lstatSync(cursor).isSymbolicLink()) throw new Error("Dashboard files must not be symbolic links"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return full;
}

export function readRawLocal(repo, path, fallback = "", maxBytes = 1_000_000) {
  const file = localPath(repo, path); if (!existsSync(file)) return fallback;
  if (!statSync(file).isFile() || statSync(file).size > maxBytes) throw new Error("File is not readable or exceeds the display limit");
  return readFileSync(file, "utf8");
}
export const readLocal = (repo, path, fallback = "", maxBytes) => safeText(readRawLocal(repo, path, fallback, maxBytes));
export const readJsonLocal = (repo, path, fallback = "{}") => safeValue(JSON.parse(readRawLocal(repo, path, fallback)));

export function writeLocal(repo, path, contents) {
  const file = localPath(repo, path); mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  localPath(repo, relative(repo, temp));
  writeFileSync(temp, contents, { mode: 0o600 }); renameSync(temp, file);
}

export function renderMarkdown(text) {
  return sanitizeHtml(marked.parse(safeText(text), { async: false }), {
    allowedTags: ["p", "br", "hr", "h1", "h2", "h3", "h4", "ul", "ol", "li", "strong", "em", "blockquote", "code", "pre", "table", "thead", "tbody", "tr", "th", "td", "a", "del"],
    allowedAttributes: { a: ["href", "target", "rel"] }, allowedSchemes: ["https", "http"], allowProtocolRelative: false,
    transformTags: { a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer" } }) },
  });
}

function setupSnapshot(repo) {
  const config = readRawLocal(repo, "rusubon.json", null), context = readRawLocal(repo, ".rusubon/context.md", null);
  const pending = contextDraftPending(repo);
  return { config, context, pending, revision: createHash("sha256").update(JSON.stringify([config, context, pending])).digest("hex") };
}

export function assertSetupRevision(repo, expectedRevision, snapshot = setupSnapshot(repo)) {
  if (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision)) throw new Error("Reload Setup before saving. Its revision is missing.");
  if (expectedRevision !== snapshot.revision) {
    const error = new Error("Setup changed on disk. Your edits are kept. Review the current setup before saving.");
    error.statusCode = 409;
    throw error;
  }
  return snapshot;
}

export function workspaceState(repo) {
  const snapshot = setupSnapshot(repo), context = safeText(snapshot.context || "");
  let raw = {}, error = "";
  try { raw = safeValue(JSON.parse(snapshot.config || "{}")); } catch { error = "rusubon.json contains invalid JSON"; }
  const config = { posthog: { projectId: String(raw.posthog?.projectId || ""), host: raw.posthog?.host || "" }, runner: raw.runner || "claude", model: raw.model || "claude-sonnet-5", effort: raw.effort || "high", read: { model: raw.read?.model || "claude-sonnet-5", effort: raw.read?.effort || "low" } };
  config.spec = raw.spec || { ...DEFAULT_SPEC_SELECTION };
  config.implementation = raw.implementation || { runner: config.runner, model: config.model, effort: config.effort };
  config.scout = raw.scout || DEFAULT_SCOUT;
  return { repo, name: repo.split(sep).pop(), initialized: snapshot.config !== null, config, context, moneyPaths: moneyPaths(context), revision: snapshot.revision, confirmed: !snapshot.pending && Boolean(context) && !context.includes(PLACEHOLDER), error };
}

export function saveSetup(repo, input) {
  const snapshot = assertSetupRevision(repo, input.expectedRevision);
  if (snapshot.pending) throw new Error("Wait for context draft recovery before saving setup.");
  const selection = validateSavedSelection(input);
  const id = String(input.projectId || "").trim();
  if (!/^\d+$/.test(id)) throw new Error("PostHog project ID must be a number");
  if (!["us", "eu"].includes(input.host)) throw new Error("Choose the PostHog US or EU region");
  if (typeof input.context !== "string" || input.context.length > 100_000) throw new Error("Product context is missing or too large");
  if (safeText(input.context) !== input.context) throw new Error("Remove credentials from product context before saving");
  const body = input.context.replace(/<!--\s*RUSUBON_CONTEXT_PLACEHOLDER[\s\S]*?-->\s*/g, "").trim();
  if (input.confirmed && (missingSections(body).length || !body.includes("# Money paths\n"))) throw new Error("Include Product, Money paths, Intentional friction, and Out of scope headings before confirming");
  const context = input.confirmed ? `${body}\n` : sealDraft(body);
  let existing = {}; try { existing = JSON.parse(snapshot.config || "{}"); } catch { throw new Error("Fix invalid rusubon.json before saving setup"); }
  const read = validateSavedSelection({ runner: "claude", model: input.readModel || "claude-sonnet-5", effort: "low" });
  const spec = validateSavedSelection(input.spec || existing.spec || DEFAULT_SPEC_SELECTION, "spec");
  const implementation = validateSavedSelection(input.implementation || existing.implementation || selection, "implementation");
  const scout = input.scout || existing.scout ? scoutOptions(input.scout || existing.scout) : undefined;
  if (scout) scoutWindow(scout);
  if (scout && safeText(scout.note) !== scout.note) throw new Error("Remove credentials from additional context before saving.");
  writeLocal(repo, "rusubon.json", JSON.stringify({ ...existing, ...selection, spec, implementation, ...(scout ? { scout } : {}), posthog: { projectId: id, host: input.host }, read: { model: read.model, effort: "low" } }, null, 2) + "\n");
  writeLocal(repo, ".rusubon/context.md", context);
  return workspaceState(repo);
}

export function reports(repo, archived = false) {
  const folder = `.rusubon/inbox/${archived ? "archive" : "reports"}`;
  const dir = localPath(repo, folder); if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => /^[a-z0-9][a-z0-9-]*\.md$/.test(name)).map(name => {
    const body = readLocal(repo, `${folder}/${name}`);
    return { slug: name.slice(0, -3), archived, ...parseReport(body, name), modifiedAt: statSync(localPath(repo, `${folder}/${name}`)).mtime.toISOString() };
  }).sort((a, b) => a.priority.localeCompare(b.priority) || b.modifiedAt.localeCompare(a.modifiedAt));
}

export function reportDetail(repo, slug) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error("Invalid report slug");
  for (const folder of ["reports", "archive"]) {
    const path = `.rusubon/inbox/${folder}/${slug}.md`;
    if (existsSync(localPath(repo, path))) {
      const body = readLocal(repo, path);
      const display = body.replace(/^priority:\s*P[123]\s*$/gmi, "").replace(/^actionability:\s*\S+\s*$/gmi, "").replace(/^priority_explanation:\s*(.+)$/gmi, "$1\n");
      return { slug, path, archived: folder === "archive", ...parseReport(body, slug), body, html: renderMarkdown(display) };
    }
  }
  throw new Error("Finding not found");
}

export function canonicalRepo(path) {
  const repo = realpathSync(resolve(path));
  if (!statSync(repo).isDirectory()) throw new Error("Choose a repository directory");
  localPath(repo, ".rusubon"); return repo;
}
