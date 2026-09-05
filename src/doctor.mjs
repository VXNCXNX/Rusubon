import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { PLACEHOLDER_HOST, PLACEHOLDER_PROJECT, resolveHost } from "./config.mjs";
import { PLACEHOLDER, loadContext } from "./context.mjs";
import { RUNNERS } from "./runners.mjs";

function which(bin) {
  const r = spawnSync("which", [bin], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

/** Replace recognized PostHog tokens and Bearer credentials before displaying or saving text. */
export function redact(text) {
  return String(text || "")
    .replace(/phx_[A-Za-z0-9]+/g, "phx_REDACTED")
    .replace(/phc_[A-Za-z0-9]+/g, "phc_REDACTED")
    .replace(/Bearer\s+\S+/gi, "Bearer REDACTED");
}

function runCmd(bin, args) {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 15000 });
  return {
    status: r.status,
    out: `${r.stdout || ""}\n${r.stderr || ""}`.trim(),
  };
}

export function defaultProbes() {
  return {
    which,
    claudeAuth() {
      const bin = process.env.RUSUBON_CLAUDE || "claude";
      const r = runCmd(bin, ["auth", "status"]);
      try {
        const json = JSON.parse((r.out.match(/\{[\s\S]*\}/) || [r.out])[0]);
        return { loggedIn: Boolean(json.loggedIn), raw: r.out };
      } catch {
        return { loggedIn: /loggedIn["']?\s*:\s*true/i.test(r.out), raw: r.out };
      }
    },
    claudeMcpList() {
      const bin = process.env.RUSUBON_CLAUDE || "claude";
      return runCmd(bin, ["mcp", "list"]).out;
    },
    agentStatus() {
      const bin = which("agent") || "agent";
      return runCmd(bin, ["status"]).out;
    },
    agentMcpList() {
      const bin = which("agent") || "agent";
      return runCmd(bin, ["mcp", "list"]).out;
    },
    ghAuth() {
      return runCmd("gh", ["auth", "status"]);
    },
    ghRepo() {
      return runCmd("gh", ["repo", "view", "--json", "nameWithOwner"]);
    },
    ghIssue(number, repo) {
      return runCmd("gh", [
        "issue",
        "view",
        String(number),
        "--repo",
        repo,
        "--json",
        "number,title,body,url,state,labels",
      ]);
    },
  };
}

function checkConfig(config) {
  if (!config) return { name: "config", ok: false, detail: "no rusubon.json. run `rusubon init` first." };
  return { name: "config", ok: true, detail: "rusubon.json" };
}

function checkProject(config) {
  const id = config?.posthog?.projectId;
  if (!id || id === PLACEHOLDER_PROJECT) {
    return {
      name: "project",
      ok: false,
      detail: `set posthog.projectId in rusubon.json (not ${PLACEHOLDER_PROJECT})`,
    };
  }
  return { name: "project", ok: true, detail: id };
}

function checkHost(config) {
  const raw = config?.posthog?.host;
  if (!raw || raw === PLACEHOLDER_HOST) {
    return {
      name: "host",
      ok: false,
      detail: "set posthog.host to us or eu (https://us.posthog.com / https://eu.posthog.com)",
    };
  }
  const host = resolveHost(raw);
  if (!host) {
    return {
      name: "host",
      ok: false,
      detail: `posthog.host must be us or eu (got ${raw})`,
    };
  }
  return { name: "host", ok: true, detail: host };
}

function checkContext() {
  try {
    const { body } = loadContext();
    if (body.includes(PLACEHOLDER)) {
      return {
        name: "context",
        ok: false,
        detail: "placeholder still in .rusubon/context.md — fill it, then delete the placeholder comment",
      };
    }
    return { name: "context", ok: true, detail: ".rusubon/context.md" };
  } catch (err) {
    return { name: "context", ok: false, detail: err.message };
  }
}

function checkRunner(config, probes) {
  const name = config?.runner || "claude";
  if (name === "claude" && process.env.RUSUBON_CLAUDE) {
    const bin = probes.which(process.env.RUSUBON_CLAUDE);
    if (!bin && !existsSync(process.env.RUSUBON_CLAUDE)) {
      return { name: "runner", ok: false, detail: `RUSUBON_CLAUDE not found: ${process.env.RUSUBON_CLAUDE}` };
    }
    return { name: "runner", ok: true, detail: `claude via ${process.env.RUSUBON_CLAUDE}` };
  }
  const spec = RUNNERS[name];
  if (!spec) return { name: "runner", ok: false, detail: `unknown runner '${name}'` };
  const bin = spec.which();
  if (!bin) {
    return {
      name: "runner",
      ok: false,
      detail: `'${name}' not on PATH. install the CLI and log in`,
    };
  }
  return { name: "runner", ok: true, detail: `${name} (${bin})` };
}

function checkAuth(config, probes) {
  const name = config?.runner || "claude";
  if (name === "claude") {
    if (process.env.RUSUBON_CLAUDE) {
      return { name: "auth", ok: true, detail: "RUSUBON_CLAUDE set (skip claude login)" };
    }
    const auth = probes.claudeAuth();
    if (auth.loggedIn) return { name: "auth", ok: true, detail: "claude logged in" };
    return {
      name: "auth",
      ok: false,
      detail: "claude not logged in. run `claude login`, or set RUSUBON_CLAUDE to another claude wrapper",
    };
  }
  if (name === "cursor") {
    const text = probes.agentStatus();
    if (/logged in/i.test(text) && !/not logged|logged out/i.test(text)) {
      return { name: "auth", ok: true, detail: "cursor agent logged in" };
    }
    return { name: "auth", ok: false, detail: "cursor agent not logged in. run `agent login`" };
  }
  if (name === "codex") {
    return { name: "auth", ok: true, detail: "codex on PATH (login is the CLI's)" };
  }
  return { name: "auth", ok: false, detail: `unknown runner '${name}'` };
}

export function posthogMcpOk(text) {
  const lines = String(text || "").split(/\r?\n/);
  const hit = lines.find((l) => /posthog/i.test(l));
  if (!hit) return false;
  if (/fail|error|✗|×/i.test(hit) && !/connected/i.test(hit)) return false;
  return /connected|✔/i.test(hit);
}

function checkMcp(config, probes) {
  const name = config?.runner || "claude";
  const text = name === "cursor" ? probes.agentMcpList() : probes.claudeMcpList();
  if (posthogMcpOk(text)) {
    return { name: "mcp", ok: true, detail: "posthog connected" };
  }
  return {
    name: "mcp",
    ok: false,
    detail:
      "no official PostHog MCP on this runner. `npx @posthog/wizard mcp add` or add https://mcp.posthog.com/mcp to user config — not the repo",
  };
}

function checkGh(probes) {
  if (typeof probes.ghAuth !== "function") {
    return { name: "gh", ok: false, detail: "gh not authenticated. run `gh auth login`" };
  }
  const r = probes.ghAuth();
  if (r && r.status === 0) return { name: "gh", ok: true, detail: "gh authenticated" };
  return {
    name: "gh",
    ok: false,
    detail: redact(r?.out) || "gh not authenticated. run `gh auth login`",
  };
}

export function collectChecks(config, probes = defaultProbes()) {
  const local = [checkConfig(config), checkProject(config), checkHost(config), checkContext()];
  if (local.some((c) => !c.ok)) return local;
  return [
    ...local,
    checkRunner(config, probes),
    checkAuth(config, probes),
    checkMcp(config, probes),
  ];
}

export function collectPrChecks(config, probes = defaultProbes()) {
  return [
    checkConfig(config),
    checkRunner(config, probes),
    checkAuth(config, probes),
    checkGh(probes),
  ];
}

export function formatDoctor(checks, title = "rusubon doctor") {
  const lines = [title, ""];
  for (const c of checks) {
    const mark = c.ok ? "ok  " : "fail";
    lines.push(`${mark}  ${c.name.padEnd(8)}  ${redact(c.detail)}`);
  }
  return lines.join("\n");
}

export function assertReady(config, probes = defaultProbes()) {
  const checks = collectChecks(config, probes);
  const failed = checks.filter((c) => !c.ok);
  if (!failed.length) return checks;
  throw new Error(
    `${formatDoctor(checks)}\n\nfix the failed checks, then \`rusubon run\`.`,
  );
}

export function assertPrReady(config, probes = defaultProbes()) {
  const checks = collectPrChecks(config, probes);
  const failed = checks.filter((c) => !c.ok);
  if (!failed.length) return checks;
  throw new Error(
    `${formatDoctor(checks, "rusubon pr")}\n\nfix the failed checks, then \`rusubon pr\`.`,
  );
}
