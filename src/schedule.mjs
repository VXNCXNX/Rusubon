import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_NAME } from "./config.mjs";
import { assertReady } from "./doctor.mjs";
import { acquireRepoLock } from "./lock.mjs";
import { kicksDir, patrolPath, runsDir } from "./paths.mjs";
import { runSkill as runSkillImpl } from "./run.mjs";
import { readHost, removeHost, tickArgv, writeHost } from "./schedule-host.mjs";
import { listScouts, resolveScout } from "./scout-scope.mjs";

const CRON_BOUNDS = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function writeAtomic(path, text) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function parseDate(value) {
  if (value == null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`bad date: ${value}`);
  return date;
}

function dumpDate(value) {
  return value ? new Date(value).toISOString() : null;
}

function parseCronField(field, min, max) {
  if (!field) throw new Error("cron must be 5 POSIX fields (UTC)");
  for (const part of field.split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new Error("bad cron step");
    if (range === "*") continue;
    const bits = range.split("-");
    if (bits.length > 2) throw new Error("bad cron range");
    const start = Number(bits[0]);
    const end = bits.length === 2 ? Number(bits[1]) : start;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw new Error("bad cron field");
    }
  }
}

function parseCronExpr(text) {
  const fields = String(text || "").trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron must be 5 POSIX fields (UTC)");
  fields.forEach((field, i) => parseCronField(field, CRON_BOUNDS[i][0], CRON_BOUNDS[i][1]));
  return fields.join(" ");
}

function matchField(field, value, min, max) {
  return field.split(",").some((part) => {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    let start;
    let end;
    if (range === "*") {
      start = min;
      end = max;
    } else if (range.includes("-")) {
      const bits = range.split("-");
      start = Number(bits[0]);
      end = Number(bits[1]);
    } else {
      start = end = Number(range);
    }
    if (value < start || value > end) return false;
    return (value - start) % step === 0;
  });
}

function cronMatches(fields, date) {
  const [minute, hour, dom, month, dow] = fields;
  const minuteOk = matchField(minute, date.getUTCMinutes(), 0, 59);
  const hourOk = matchField(hour, date.getUTCHours(), 0, 23);
  const monthOk = matchField(month, date.getUTCMonth() + 1, 1, 12);
  const dowValue = date.getUTCDay();
  const domOk = matchField(dom, date.getUTCDate(), 1, 31);
  const dowOk = matchField(dow, dowValue, 0, 7) || (dowValue === 0 && matchField(dow, 7, 0, 7));
  // POSIX: when both DOM and DOW are restricted, either field may match.
  const dayOk = dom === "*" && dow === "*" ? true : dom === "*" ? dowOk : dow === "*" ? domOk : domOk || dowOk;
  return minuteOk && hourOk && monthOk && dayOk;
}

function parseEveryObject(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("bad every");
  const extra = Object.keys(raw).filter((key) => key !== "minutes");
  if (extra.length) throw new Error(`unknown every key: ${extra[0]}`);
  const minutes = Number(raw.minutes);
  if (!Number.isInteger(minutes) || minutes < 1) throw new Error("bad every.minutes");
  return { minutes };
}

function parseCadence(value) {
  if (typeof value === "string") {
    if (/^\d+[mhd]$/.test(value)) return { kind: "interval", every: parseDuration(value) };
    return { kind: "cron", expr: parseCronExpr(value) };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("bad cadence");
  const extra = Object.keys(value).filter((key) => key !== "every" && key !== "cron");
  if (extra.length) throw new Error(`unknown cadence key: ${extra[0]}`);
  if (Object.hasOwn(value, "every") && Object.hasOwn(value, "cron")) {
    throw new Error("cadence cannot carry both every and cron");
  }
  if (Object.hasOwn(value, "every")) {
    const every = typeof value.every === "string" ? parseDuration(value.every) : parseEveryObject(value.every);
    return { kind: "interval", every };
  }
  if (Object.hasOwn(value, "cron")) return { kind: "cron", expr: parseCronExpr(value.cron) };
  throw new Error("cadence needs every or cron");
}

function nextDueAt(cadence, lastPatrolAt, now) {
  if (lastPatrolAt == null || isDue(cadence, lastPatrolAt, now)) return "now";
  if (cadence.kind === "interval") return new Date(lastPatrolAt.getTime() + cadence.every.minutes * 60_000);
  return nextCronFire(cadence.expr, lastPatrolAt);
}

function emptyLedger() {
  return { version: 1, lastTickAt: null, lastSkip: null, scouts: {} };
}

function kickPath(scout) {
  return resolve(kicksDir(), `${resolveScout(scout).name}.json`);
}

function scopedConfig(config) {
  if (config.scout) return config;
  return { ...config, scout: { period: "7d", focus: "all" } };
}

function cadenceLabel(cadence) {
  return cadence.kind === "interval" ? `${cadence.every.minutes}m` : cadence.expr;
}

function scaffoldSchedule(repo) {
  const path = resolve(repo, CONFIG_NAME);
  if (!existsSync(path)) throw new Error(`no ${CONFIG_NAME} here. run \`rusubon init\` first.`);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (Object.hasOwn(raw, "schedule")) return false;
  raw.schedule = { friction: "24h", errors: "24h" };
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
  console.log("wrote schedule friction=24h errors=24h (was missing)");
  return true;
}

/** @param {unknown} raw */
export function parseSchedule(raw) {
  if (raw == null) return { scouts: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("schedule must be an object");
  return {
    scouts: Object.entries(raw).map(([key, value]) => ({
      scout: resolveScout(key).name,
      cadence: parseCadence(value),
    })),
  };
}

/** @param {string} text */
export function parseDuration(text) {
  const match = String(text || "").trim().match(/^(\d+)([mhd])$/);
  if (!match) throw new Error(`bad duration: ${text}`);
  const n = Number(match[1]);
  if (n < 1) throw new Error(`bad duration: ${text}`);
  return { minutes: match[2] === "m" ? n : match[2] === "h" ? n * 60 : n * 1440 };
}

/**
 * First fire strictly after `after`, UTC.
 * @param {string} expr
 * @param {Date} after
 * @returns {Date}
 */
export function nextCronFire(expr, after) {
  const fields = parseCronExpr(expr).split(" ");
  const cursor = new Date(after.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const limit = after.getTime() + 366 * 24 * 60 * 60 * 1000;
  while (cursor.getTime() <= limit) {
    if (cronMatches(fields, cursor)) return new Date(cursor.getTime());
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  throw new Error(`no cron fire after ${after.toISOString()}`);
}

/**
 * @param {{ kind: string, every?: { minutes: number }, expr?: string }} cadence
 * @param {Date | null} lastPatrolAt
 * @param {Date} now
 */
export function isDue(cadence, lastPatrolAt, now) {
  if (lastPatrolAt == null) return true;
  if (cadence.kind === "interval") return now.getTime() - lastPatrolAt.getTime() >= cadence.every.minutes * 60_000;
  return nextCronFire(cadence.expr, lastPatrolAt) <= now;
}

/**
 * @param {{ scouts: { scout: string, cadence: object }[] }} policy
 * @param {{ scouts?: object }} ledger
 * @param {string[]} kicks
 * @param {Date} now
 */
export function planTick(policy, ledger, kicks, now) {
  const kickSet = new Set(kicks);
  const byScout = new Map((policy.scouts || []).map((row) => [row.scout, row]));
  const work = [];
  for (const { name } of listScouts()) {
    const row = byScout.get(name);
    const due = row ? isDue(row.cadence, ledger.scouts?.[name]?.lastPatrolAt ?? null, now) : false;
    const kicked = kickSet.has(name);
    if (due && kicked) work.push({ scout: name, origin: "patrol+kick" });
    else if (due) work.push({ scout: name, origin: "patrol" });
    else if (kicked) work.push({ scout: name, origin: "kick" });
  }
  return work;
}

function patrolStamp(ledger, scout) {
  const value = ledger.scouts?.[scout]?.lastPatrolAt ?? null;
  if (value == null) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

/** Kick first, then never-run, then oldest lastPatrolAt, then catalog order. */
export function pickTickWork(work, ledger) {
  if (!work.length) return null;
  const order = new Map(listScouts().map((row, i) => [row.name, i]));
  return [...work].sort((a, b) => {
    const kickA = a.origin.includes("kick") ? 0 : 1;
    const kickB = b.origin.includes("kick") ? 0 : 1;
    if (kickA !== kickB) return kickA - kickB;
    const lastA = patrolStamp(ledger, a.scout);
    const lastB = patrolStamp(ledger, b.scout);
    if (lastA == null && lastB != null) return -1;
    if (lastB == null && lastA != null) return 1;
    if (lastA != null && lastB != null && lastA !== lastB) return lastA - lastB;
    return (order.get(a.scout) ?? 0) - (order.get(b.scout) ?? 0);
  })[0];
}

/**
 * @param {object} ledger
 * @param {{ scout: string, origin: string }} work
 * @param {Date} now
 */
export function applySuccess(ledger, work, now) {
  const row = ledger.scouts[work.scout] || { lastPatrolAt: null, lastKickAt: null };
  if (work.origin === "patrol" || work.origin === "patrol+kick") row.lastPatrolAt = now;
  if (work.origin === "kick" || work.origin === "patrol+kick") row.lastKickAt = now;
  ledger.scouts[work.scout] = row;
  return ledger;
}

export function loadLedger() {
  const path = patrolPath();
  if (!existsSync(path)) return emptyLedger();
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (raw.version !== 1) throw new Error("unsupported patrol ledger version");
  return {
    version: 1,
    lastTickAt: parseDate(raw.lastTickAt),
    lastSkip: raw.lastSkip
      ? { at: parseDate(raw.lastSkip.at), reason: raw.lastSkip.reason, detail: String(raw.lastSkip.detail || "") }
      : null,
    scouts: Object.fromEntries(
      Object.entries(raw.scouts || {}).map(([name, row]) => [
        name,
        { lastPatrolAt: parseDate(row.lastPatrolAt), lastKickAt: parseDate(row.lastKickAt) },
      ]),
    ),
  };
}

export function saveLedger(ledger) {
  mkdirSync(runsDir(), { recursive: true });
  const dumped = {
    version: 1,
    lastTickAt: dumpDate(ledger.lastTickAt),
    lastSkip: ledger.lastSkip
      ? { at: dumpDate(ledger.lastSkip.at), reason: ledger.lastSkip.reason, detail: ledger.lastSkip.detail }
      : null,
    scouts: Object.fromEntries(
      Object.entries(ledger.scouts || {}).map(([name, row]) => [
        name,
        { lastPatrolAt: dumpDate(row.lastPatrolAt), lastKickAt: dumpDate(row.lastKickAt) },
      ]),
    ),
  };
  writeAtomic(patrolPath(), JSON.stringify(dumped, null, 2) + "\n");
}

/** @param {string} scout @param {string | null} reason */
export function writeKick(scout, reason) {
  mkdirSync(kicksDir(), { recursive: true });
  const name = resolveScout(scout).name;
  const body = { scout: name, at: new Date().toISOString(), reason: reason || null };
  writeAtomic(kickPath(name), JSON.stringify(body, null, 2) + "\n");
}

export function loadKicks() {
  if (!existsSync(kicksDir())) return [];
  const out = [];
  for (const row of listScouts()) {
    const path = kickPath(row.name);
    if (!existsSync(path)) continue;
    const raw = JSON.parse(readFileSync(path, "utf8"));
    out.push({ scout: resolveScout(raw.scout).name, at: parseDate(raw.at), reason: raw.reason ?? null });
  }
  return out;
}

export function clearKick(scout) {
  const path = kickPath(scout);
  if (existsSync(path)) unlinkSync(path);
}

/**
 * @param {object} config
 * @param {object} [opts]
 */
export async function tick(config, opts = {}) {
  const now = opts.now || new Date();
  const run = opts.run || runSkillImpl;
  const policy = parseSchedule(config.schedule);
  const kickName = opts.kick ? resolveScout(opts.kick).name : null;

  if (opts.dryRun) {
    const pending = loadKicks().map((row) => row.scout);
    if (kickName) pending.push(kickName);
    return { status: "dry_run", at: now, work: planTick(policy, loadLedger(), [...new Set(pending)], now) };
  }

  if (kickName) writeKick(kickName, opts.reason || null);

  let release;
  try {
    release = acquireRepoLock(process.cwd());
  } catch (error) {
    if (error.code === "RUN_LOCKED") return { status: "busy", at: now };
    throw error;
  }

  try {
    if (config.permissionMode === "ask") {
      const ledger = loadLedger();
      ledger.lastSkip = { at: now, reason: "unattended_ask", detail: "tick refuses permissionMode ask" };
      ledger.lastTickAt = now;
      saveLedger(ledger);
      return { status: "skipped", at: now, reason: "unattended_ask", detail: "set permissionMode to auto or yolo" };
    }

    try {
      assertReady(config, opts.probes);
    } catch (error) {
      const ledger = loadLedger();
      ledger.lastSkip = { at: now, reason: "not_ready", detail: error.message };
      ledger.lastTickAt = now;
      saveLedger(ledger);
      return { status: "skipped", at: now, reason: "not_ready", detail: error.message };
    }

    const ledger = loadLedger();
    const work = planTick(policy, ledger, loadKicks().map((row) => row.scout), now);
    if (!work.length) {
      ledger.lastTickAt = now;
      ledger.lastSkip = null;
      saveLedger(ledger);
      return { status: "quiet", at: now };
    }

    const item = pickTickWork(work, ledger);
    try {
      await run(item.scout, scopedConfig(config), opts.probes);
    } catch (error) {
      ledger.lastSkip = { at: now, reason: "run_failed", detail: error.message };
      ledger.lastTickAt = now;
      saveLedger(ledger);
      throw error;
    }
    applySuccess(ledger, item, now);
    if (item.origin !== "patrol") clearKick(item.scout);
    ledger.lastTickAt = now;
    ledger.lastSkip = null;
    saveLedger(ledger);
    return { status: "ran", at: now, ran: [{ scout: item.scout, origin: item.origin }] };
  } finally {
    release();
  }
}

/** @param {object} config */
export function scheduleStatus(config) {
  const policy = parseSchedule(config.schedule);
  const ledger = loadLedger();
  const now = new Date();
  return {
    policy,
    ledger,
    host: readHost(process.cwd()),
    next: policy.scouts.map((row) => ({
      scout: row.scout,
      dueAt: nextDueAt(row.cadence, ledger.scouts[row.scout]?.lastPatrolAt ?? null, now),
    })),
    pendingKicks: loadKicks().map((row) => row.scout),
  };
}

/** @param {{ tickEvery: string, repo?: string, probes?: object, platform?: string }} opts */
export function installSchedule(opts) {
  const repo = resolve(opts.repo || process.cwd());
  const tickEvery = parseDuration(opts.tickEvery);
  if (tickEvery.minutes > 59) throw new Error("host tick interval must be 1-59 minutes");
  scaffoldSchedule(repo);
  const host = writeHost({
    repo,
    bin: tickArgv(),
    tickEvery,
    probes: opts.probes,
    platform: opts.platform,
  });
  console.log("installed host timer (one per product checkout)");
  return host;
}

export function uninstallSchedule(repo = process.cwd(), opts = {}) {
  return removeHost(resolve(repo), opts);
}

export function printScheduleStatus(status) {
  const lines = [];
  if (!status.policy.scouts.length) lines.push("schedule  (empty)");
  for (const row of status.policy.scouts) {
    lines.push(`schedule  ${row.scout}  ${cadenceLabel(row.cadence)}`);
  }
  const host = status.host.installed && status.host.tickEvery
    ? `${status.host.kind}  every ${status.host.tickEvery.minutes}m`
    : status.host.installed
      ? `${status.host.kind}  interval unknown`
      : `${status.host.kind}  not installed`;
  lines.push(`host      ${host}  (one per product checkout)`);
  lines.push(`pending   ${status.pendingKicks.join(" ") || "(none)"}`);
  for (const row of status.next) {
    const when = row.dueAt === "now" ? "now" : row.dueAt.toISOString();
    lines.push(`next      ${row.scout}  ${when}`);
  }
  if (status.ledger.lastSkip) {
    lines.push(`lastSkip  ${status.ledger.lastSkip.reason}  ${status.ledger.lastSkip.detail}`);
  }
  console.log(lines.join("\n"));
}

export function formatTick(result) {
  return result.status;
}
