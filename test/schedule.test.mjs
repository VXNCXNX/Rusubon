import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { trashFixture } from "./helpers/cleanup.mjs";
import { main } from "../src/cli.mjs";
import { initConfig, loadConfig } from "../src/config.mjs";
import { acquireRepoLock } from "../src/lock.mjs";
import { kicksDir, patrolPath } from "../src/paths.mjs";
import {
  applySuccess,
  formatTick,
  installSchedule,
  isDue,
  parseDuration,
  parseSchedule,
  planTick,
  printScheduleStatus,
  saveLedger,
  scheduleStatus,
  tick,
} from "../src/schedule.mjs";
import { readHost, writeHost } from "../src/schedule-host.mjs";

const prev = process.cwd();
const dirs = [];

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "rusubon-"));
  dirs.push(dir);
  process.chdir(dir);
  return dir;
}

afterEach(() => {
  process.chdir(prev);
  for (const dir of dirs.splice(0)) trashFixture(dir);
});

function fillContext() {
  mkdirSync(join(process.cwd(), ".rusubon"), { recursive: true });
  writeFileSync(
    join(process.cwd(), ".rusubon", "context.md"),
    `# Product\nA demo app.\n\n# Money paths\n- /checkout\n\n# Intentional friction\n- paywall after free quota\n\n# Out of scope\n- staging\n`,
  );
}

function readyConfig(schedule, extra = {}) {
  initConfig();
  fillContext();
  writeFileSync(
    "rusubon.json",
    JSON.stringify({
      posthog: { projectId: "123", host: "https://us.posthog.com" },
      runner: "claude",
      permissionMode: extra.permissionMode || "auto",
      ...(schedule !== undefined ? { schedule } : {}),
      ...(extra.scout ? { scout: extra.scout } : {}),
    }, null, 2) + "\n",
  );
  return loadConfig();
}

const okProbes = {
  which: () => "/usr/bin/claude",
  claudeAuth: () => ({ loggedIn: true, raw: "" }),
  claudeMcpList: () => "posthog: https://mcp.posthog.com/mcp (HTTP) - ✔ Connected",
  agentStatus: () => "Logged in as someone",
  agentMcpList: () => "",
};

function hostStore() {
  const store = { text: "" };
  return {
    store,
    probes: {
      run(bin, args, opts = {}) {
        if (bin === "crontab" && args[0] === "-l") return { status: 0, stdout: store.text, stderr: "" };
        if (bin === "crontab" && args[0] === "-") {
          store.text = opts.input || "";
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    },
  };
}

function emptyLedger(scouts = {}) {
  return { version: 1, lastTickAt: null, lastSkip: null, scouts };
}

const now = new Date("2026-01-03T12:00:00.000Z");

test("never-ran scout is due", () => {
  assert.deepEqual(
    planTick(parseSchedule({ friction: "24h" }), emptyLedger(), [], now),
    [{ scout: "friction", origin: "patrol" }],
  );
});

test("interval not elapsed and no kick is quiet", async () => {
  tmp();
  const last = new Date("2026-01-03T00:00:00.000Z");
  const config = readyConfig({ friction: "24h" });
  saveLedger(emptyLedger({ friction: { lastPatrolAt: last, lastKickAt: null } }));
  const result = await tick(config, {
    now,
    probes: okProbes,
    run: async () => { throw new Error("should not run"); },
  });
  assert.deepEqual(result, { status: "quiet", at: now });
  assert.deepEqual(JSON.parse(readFileSync(patrolPath(), "utf8")), {
    version: 1,
    lastTickAt: now.toISOString(),
    lastSkip: null,
    scouts: { friction: { lastPatrolAt: last.toISOString(), lastKickAt: null } },
  });
});

test("two missed interval lengths become one work item", () => {
  const last = new Date("2026-01-01T12:00:00.000Z");
  assert.deepEqual(
    planTick(
      parseSchedule({ friction: "24h" }),
      emptyLedger({ friction: { lastPatrolAt: last, lastKickAt: null } }),
      [],
      now,
    ),
    [{ scout: "friction", origin: "patrol" }],
  );
});

test("kick only does not stamp lastPatrolAt", async () => {
  tmp();
  const last = new Date("2026-01-03T00:00:00.000Z");
  const config = readyConfig({ friction: "24h" });
  saveLedger(emptyLedger({ friction: { lastPatrolAt: last, lastKickAt: null } }));
  const result = await tick(config, {
    kick: "friction",
    now,
    probes: okProbes,
    run: async () => {},
  });
  assert.deepEqual(result, { status: "ran", at: now, ran: [{ scout: "friction", origin: "kick" }] });
  assert.deepEqual(JSON.parse(readFileSync(patrolPath(), "utf8")).scouts.friction, {
    lastPatrolAt: last.toISOString(),
    lastKickAt: now.toISOString(),
  });
  assert.equal(existsSync(join(kicksDir(), "friction.json")), false);
});

test("due plus kick is one patrol+kick item and stamps lastPatrolAt", async () => {
  tmp();
  const config = readyConfig({ friction: "24h" });
  const result = await tick(config, {
    kick: "friction",
    now,
    probes: okProbes,
    run: async () => {},
  });
  assert.deepEqual(result, { status: "ran", at: now, ran: [{ scout: "friction", origin: "patrol+kick" }] });
  assert.deepEqual(JSON.parse(readFileSync(patrolPath(), "utf8")).scouts.friction, {
    lastPatrolAt: now.toISOString(),
    lastKickAt: now.toISOString(),
  });
});

test("run throw leaves the scout due", async () => {
  tmp();
  const config = readyConfig({ friction: "24h", errors: "24h" });
  await assert.rejects(
    () => tick(config, { now, probes: okProbes, run: async () => { throw new Error("boom"); } }),
    /boom/,
  );
  const ledger = JSON.parse(readFileSync(patrolPath(), "utf8"));
  assert.equal(ledger.scouts.friction?.lastPatrolAt ?? null, null);
  assert.deepEqual(ledger.lastSkip, { at: now.toISOString(), reason: "run_failed", detail: "boom" });
  assert.deepEqual(
    planTick(parseSchedule(config.schedule), emptyLedger(), [], now),
    [
      { scout: "friction", origin: "patrol" },
      { scout: "errors", origin: "patrol" },
    ],
  );
});

test("busy lock leaves the kick file", async () => {
  tmp();
  initConfig();
  const release = acquireRepoLock(process.cwd());
  try {
    const result = await tick({ schedule: { friction: "24h" } }, { kick: "friction", now, run: async () => {} });
    assert.deepEqual(result, { status: "busy", at: now });
    assert.deepEqual(JSON.parse(readFileSync(join(kicksDir(), "friction.json"), "utf8")).scout, "friction");
    assert.equal(existsSync(patrolPath()), false);
  } finally {
    release();
  }
});

test("permissionMode ask is skipped and does not run", async () => {
  tmp();
  const calls = [];
  const result = await tick(
    { permissionMode: "ask", schedule: { friction: "24h" } },
    { now, run: async (name) => { calls.push(name); } },
  );
  assert.deepEqual(result, {
    status: "skipped",
    at: now,
    reason: "unattended_ask",
    detail: "set permissionMode to auto or yolo",
  });
  assert.deepEqual(calls, []);
  assert.equal(JSON.parse(readFileSync(patrolPath(), "utf8")).lastSkip.reason, "unattended_ask");
});

test("parseSchedule rejects every and cron together", () => {
  assert.throws(
    () => parseSchedule({ friction: { every: "24h", cron: "0 6 * * *" } }),
    /both every and cron/,
  );
});

test("installSchedule twice with 15m leaves one host unit", () => {
  const dir = tmp();
  initConfig();
  const host = hostStore();
  const first = installSchedule({ tickEvery: "15m", repo: dir, probes: host.probes, platform: "linux" });
  const second = installSchedule({ tickEvery: "15m", repo: dir, probes: host.probes, platform: "linux" });
  assert.deepEqual(first, { kind: "cron", installed: true, tickEvery: { minutes: 15 } });
  assert.deepEqual(second, { kind: "cron", installed: true, tickEvery: { minutes: 15 } });
  assert.deepEqual(readHost(dir, { probes: host.probes, platform: "linux" }), {
    kind: "cron",
    installed: true,
    tickEvery: { minutes: 15 },
  });
  assert.equal(host.store.text.split("\n").filter((line) => line.includes("rusubon-tick")).length, 1);
});

test("two due scouts run once", async () => {
  tmp();
  const config = readyConfig({ friction: "24h", errors: "24h" });
  const calls = [];
  const result = await tick(config, {
    now,
    probes: okProbes,
    run: async (name, cfg) => { calls.push({ name, scout: cfg.scout }); },
  });
  assert.deepEqual(result, { status: "ran", at: now, ran: [{ scout: "friction", origin: "patrol" }] });
  assert.deepEqual(calls, [{ name: "friction", scout: { period: "7d", focus: "all" } }]);
  const ledger = JSON.parse(readFileSync(patrolPath(), "utf8"));
  assert.equal(ledger.scouts.friction.lastPatrolAt, now.toISOString());
  assert.equal(ledger.scouts.errors, undefined);
  assert.deepEqual(
    planTick(parseSchedule(config.schedule), {
      version: 1,
      lastTickAt: now,
      lastSkip: null,
      scouts: { friction: { lastPatrolAt: now, lastKickAt: null } },
    }, [], now),
    [{ scout: "errors", origin: "patrol" }],
  );
});

test("dry-run writes nothing", async () => {
  tmp();
  const config = readyConfig({ friction: "24h" });
  const result = await tick(config, { kick: "friction", dryRun: true, now, run: async () => {} });
  assert.deepEqual(result, {
    status: "dry_run",
    at: now,
    work: [{ scout: "friction", origin: "patrol+kick" }],
  });
  assert.equal(existsSync(patrolPath()), false);
  assert.equal(existsSync(join(kicksDir(), "friction.json")), false);
});

test("install scaffolds only when schedule is missing", () => {
  tmp();
  initConfig();
  const host = hostStore();
  installSchedule({ tickEvery: "15m", probes: host.probes, platform: "linux" });
  assert.deepEqual(JSON.parse(readFileSync("rusubon.json", "utf8")).schedule, {
    friction: "24h",
    errors: "24h",
  });
  const raw = JSON.parse(readFileSync("rusubon.json", "utf8"));
  raw.schedule = {};
  writeFileSync("rusubon.json", JSON.stringify(raw, null, 2) + "\n");
  installSchedule({ tickEvery: "15m", probes: host.probes, platform: "linux" });
  assert.deepEqual(JSON.parse(readFileSync("rusubon.json", "utf8")).schedule, {});
});

test("loadConfig passes schedule through unparsed", () => {
  tmp();
  initConfig();
  const schedule = { friction: "24h", errors: { cron: "0 6 * * *" } };
  const raw = JSON.parse(readFileSync("rusubon.json", "utf8"));
  raw.schedule = schedule;
  writeFileSync("rusubon.json", JSON.stringify(raw, null, 2) + "\n");
  assert.deepEqual(loadConfig().schedule, schedule);
});

test("cadence accepts interval strings, cron strings, and object forms", () => {
  assert.deepEqual(parseDuration("1d"), { minutes: 1440 });
  assert.deepEqual(parseSchedule({ friction: "24h", errors: "0 6 * * *" }), {
    scouts: [
      { scout: "friction", cadence: { kind: "interval", every: { minutes: 1440 } } },
      { scout: "errors", cadence: { kind: "cron", expr: "0 6 * * *" } },
    ],
  });
  assert.deepEqual(parseSchedule({ friction: { every: "30m" } }).scouts[0].cadence, {
    kind: "interval",
    every: { minutes: 30 },
  });
  assert.deepEqual(parseSchedule({ errors: { cron: "0 6 * * *" } }).scouts[0].cadence, {
    kind: "cron",
    expr: "0 6 * * *",
  });
  assert.throws(() => parseSchedule({ friction: "0 6 * * * *" }), /5 POSIX fields/);
});

test("null lastPatrolAt is due for cron", () => {
  const cadence = { kind: "cron", expr: "0 6 * * *" };
  const last = new Date("2026-01-01T06:00:00.000Z");
  assert.equal(isDue(cadence, null, new Date("2026-01-01T00:00:00.000Z")), true);
  assert.equal(isDue(cadence, last, new Date("2026-01-02T05:59:00.000Z")), false);
  assert.equal(isDue(cadence, last, new Date("2026-01-02T06:00:00.000Z")), true);
});

test("applySuccess stamps lastPatrolAt only when origin includes patrol", () => {
  const ledger = emptyLedger();
  applySuccess(ledger, { scout: "friction", origin: "kick" }, now);
  assert.equal(ledger.scouts.friction.lastPatrolAt, null);
  assert.equal(ledger.scouts.friction.lastKickAt, now);
  applySuccess(ledger, { scout: "friction", origin: "patrol+kick" }, now);
  assert.equal(ledger.scouts.friction.lastPatrolAt, now);
});

test("win32 host install throws", () => {
  assert.throws(
    () => writeHost({ repo: tmp(), bin: ["/usr/bin/node", "tick"], tickEvery: { minutes: 15 }, platform: "win32" }),
    /WSL/,
  );
});

test("formatTick prints one status word", () => {
  assert.equal(formatTick({ status: "quiet", at: now }), "quiet");
  assert.equal(formatTick({ status: "dry_run", at: now, work: [] }), "dry_run");
  assert.equal(formatTick({ status: "busy", at: now }), "busy");
  assert.equal(formatTick({ status: "skipped", at: now, reason: "unattended_ask", detail: "x" }), "skipped");
  assert.equal(formatTick({ status: "ran", at: now, ran: [] }), "ran");
});

test("help lists tick and schedule", async () => {
  const lines = [];
  const log = console.log;
  console.log = (text) => { lines.push(String(text)); };
  try { await main(["help"]); } finally { console.log = log; }
  assert.match(lines.join("\n"), /^ {2}rusubon tick /m);
  assert.match(lines.join("\n"), /^ {2}rusubon schedule /m);
});

test("tick --dry-run prints dry_run", async () => {
  tmp();
  readyConfig({ friction: "24h" });
  const lines = [];
  const log = console.log;
  console.log = (text) => { lines.push(String(text)); };
  try { await main(["tick", "--dry-run"]); } finally { console.log = log; }
  assert.equal(lines.at(-1), "dry_run");
});

test("schedule status shows lastSkip after an ask skip", async () => {
  tmp();
  await tick({ permissionMode: "ask", schedule: { friction: "24h" } }, { now, run: async () => {} });
  const lines = [];
  const log = console.log;
  console.log = (text) => { lines.push(String(text)); };
  try { printScheduleStatus(scheduleStatus({ schedule: { friction: "24h" } })); } finally { console.log = log; }
  assert.match(lines.join("\n"), /lastSkip  unattended_ask/);
});

test("contract names tick as the patrol entry", () => {
  const text = readFileSync(new URL("../docs/inbox-contract.md", import.meta.url), "utf8");
  const line = text.split(/\n/)[166];
  assert.equal(
    line,
    "`rusubon run <scout>` and `rusubon tick` start a scout. Tick is the patrol entry. Host install writes launchd or crontab that calls tick. Tick never opens a PR.",
  );
});
