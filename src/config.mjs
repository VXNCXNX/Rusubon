import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MEMORY_PREFIXES,
  archiveDir,
  contextPath,
  cwd,
  memoryDir,
  reportsDir,
  runsDir,
} from "./paths.mjs";

export { cwd };
export const CONFIG_NAME = "rusubon.json";
export const PLACEHOLDER_PROJECT = "YOUR_PROJECT_ID";
export const PLACEHOLDER_HOST = "YOUR_REGION";
export const POSTHOG_CLOUD = {
  us: "https://us.posthog.com",
  eu: "https://eu.posthog.com",
};

const DEFAULT_CONFIG = {
  posthog: { projectId: PLACEHOLDER_PROJECT, host: PLACEHOLDER_HOST },
  runner: "claude",
};

export function resolveHost(raw) {
  const s = String(raw || "")
    .trim()
    .replace(/\/$/, "")
    .toLowerCase();
  if (s === "us" || s === POSTHOG_CLOUD.us) return POSTHOG_CLOUD.us;
  if (s === "eu" || s === POSTHOG_CLOUD.eu) return POSTHOG_CLOUD.eu;
  return "";
}

const GITIGNORE_LINES = [".rusubon/inbox/", ".rusubon/runs/"];

export function configPath() {
  return resolve(cwd(), CONFIG_NAME);
}

export function loadConfig() {
  const path = configPath();
  if (!existsSync(path)) {
    throw new Error(`no ${CONFIG_NAME} here. run \`rusubon init\` first.`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const projectId = raw.posthog?.projectId || DEFAULT_CONFIG.posthog.projectId;
  const hostRaw = raw.posthog?.host ?? DEFAULT_CONFIG.posthog.host;
  return {
    posthog: {
      projectId,
      host: resolveHost(hostRaw) || hostRaw,
    },
    runner: raw.runner || DEFAULT_CONFIG.runner,
    read: {
      model: String(raw.read?.model || "").trim(),
      effort: String(raw.read?.effort || "low").trim() || "low",
    },
  };
}

export function initConfig() {
  const path = configPath();
  if (!existsSync(path)) {
    const example = resolve(pkgRoot(), "rusubon.example.json");
    if (existsSync(example)) copyFileSync(example, path);
    else writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    console.log(`wrote ${CONFIG_NAME}`);
  } else {
    console.log(`${CONFIG_NAME} already exists`);
  }

  mkdirSync(reportsDir(), { recursive: true });
  mkdirSync(archiveDir(), { recursive: true });
  mkdirSync(runsDir(), { recursive: true });
  for (const prefix of MEMORY_PREFIXES) {
    const dir = resolve(memoryDir(), prefix);
    mkdirSync(dir, { recursive: true });
    const keep = resolve(dir, ".gitkeep");
    if (!existsSync(keep)) writeFileSync(keep, "");
  }

  const ctx = contextPath();
  if (!existsSync(ctx)) {
    copyFileSync(resolve(pkgRoot(), "templates", "context.md"), ctx);
    console.log("wrote .rusubon/context.md — fill it in before `rusubon run`");
  }

  ensureGitignore();
  const mcpExample = resolve(cwd(), "rusubon.mcp.example.json");
  const bundled = resolve(pkgRoot(), "rusubon.mcp.example.json");
  if (!existsSync(mcpExample) && existsSync(bundled)) {
    copyFileSync(bundled, mcpExample);
    console.log("wrote rusubon.mcp.example.json (not .mcp.json)");
  }
  console.log("ready. fill .rusubon/context.md and rusubon.json, then `rusubon run friction`.");
}

function ensureGitignore() {
  const gi = resolve(cwd(), ".gitignore");
  const existing = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  const missing = GITIGNORE_LINES.filter((line) => !existing.split(/\r?\n/).includes(line));
  if (!missing.length) return;
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  if (!existsSync(gi)) writeFileSync(gi, missing.join("\n") + "\n");
  else appendFileSync(gi, prefix + missing.join("\n") + "\n");
  console.log("updated .gitignore for .rusubon/inbox and .rusubon/runs");
}

export function pkgRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}
