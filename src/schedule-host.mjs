import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function repoTag(repo) {
  return createHash("sha256").update(resolve(repo)).digest("hex").slice(0, 16);
}

function hostLabel(repo) {
  return `ai.rusubon.tick.${repoTag(repo)}`;
}

function agentPath(repo) {
  return resolve(homedir(), "Library", "LaunchAgents", `${hostLabel(repo)}.plist`);
}

function runHost(input, bin, args, opts = {}) {
  const run = input.run || input.probes?.run || ((command, argv, extra) => spawnSync(command, argv, { encoding: "utf8", ...extra }));
  return run(bin, args, opts) || { status: 0, stdout: "", stderr: "" };
}

function xml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function cronMarker(repo) {
  return `# rusubon-tick ${repoTag(repo)}`;
}

function hostInterval(minutes) {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 59) {
    throw new Error("host tick interval must be 1-59 minutes");
  }
  return minutes;
}

function launchdState(repo) {
  const path = agentPath(repo);
  if (!existsSync(path)) return { kind: "launchd", installed: false, tickEvery: null };
  const text = readFileSync(path, "utf8");
  const match = text.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
  const seconds = match ? Number(match[1]) : 0;
  return { kind: "launchd", installed: true, tickEvery: seconds ? { minutes: seconds / 60 } : null };
}

function crontabText(input) {
  const listed = runHost(input, "crontab", ["-l"]);
  if (listed.status !== 0) return "";
  return String(listed.stdout || "");
}

function cronState(repo, input = {}) {
  const marker = cronMarker(repo);
  const line = crontabText(input).split(/\n/).find((row) => row.includes(marker));
  if (!line) return { kind: "cron", installed: false, tickEvery: null };
  const star = line.match(/^\*\/(\d+)\s/);
  return { kind: "cron", installed: true, tickEvery: star ? { minutes: Number(star[1]) } : null };
}

function platformOf(input) {
  return input.platform || process.platform;
}

export function tickArgv() {
  return [process.execPath, fileURLToPath(new URL("../bin/rusubon.mjs", import.meta.url)), "tick"];
}

export function readHost(repo, input = {}) {
  const platform = platformOf(input);
  if (platform === "win32") return { kind: "none", installed: false, tickEvery: null };
  if (platform === "darwin") return launchdState(repo);
  return cronState(repo, input);
}

function writeLaunchd(input) {
  const minutes = hostInterval(input.tickEvery.minutes);
  const path = agentPath(input.repo);
  mkdirSync(dirname(path), { recursive: true });
  const args = input.bin.map((part) => `    <string>${xml(part)}</string>`).join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(hostLabel(input.repo))}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(resolve(input.repo))}</string>
  <key>StartInterval</key>
  <integer>${minutes * 60}</integer>
</dict>
</plist>
`;
  writeFileSync(path, body);
  const domain = `gui/${process.getuid()}`;
  runHost(input, "launchctl", ["bootout", domain, path]);
  runHost(input, "launchctl", ["bootstrap", domain, path]);
  return { kind: "launchd", installed: true, tickEvery: { minutes } };
}

function writeCrontab(input) {
  const minutes = hostInterval(input.tickEvery.minutes);
  const marker = cronMarker(input.repo);
  const kept = crontabText(input).split(/\n/).filter((row) => row && !row.includes(marker));
  const command = input.bin.map(shQuote).join(" ");
  kept.push(`*/${minutes} * * * * cd ${shQuote(resolve(input.repo))} && ${command} ${marker}`);
  runHost(input, "crontab", ["-"], { input: `${kept.join("\n")}\n` });
  return { kind: "cron", installed: true, tickEvery: { minutes } };
}

export function writeHost(input) {
  const platform = platformOf(input);
  if (platform === "win32") throw new Error("Use WSL for rusubon schedule install on Windows");
  const current = readHost(input.repo, input);
  if (current.installed && current.tickEvery?.minutes === input.tickEvery.minutes) return current;
  if (platform === "darwin") return writeLaunchd(input);
  return writeCrontab(input);
}

export function removeHost(repo, input = {}) {
  const platform = platformOf(input);
  if (platform === "win32") return { kind: "none", installed: false, tickEvery: null };
  if (platform === "darwin") {
    const path = agentPath(repo);
    if (existsSync(path)) {
      runHost(input, "launchctl", ["bootout", `gui/${process.getuid()}`, path]);
      unlinkSync(path);
    }
    return { kind: "launchd", installed: false, tickEvery: null };
  }
  const marker = cronMarker(repo);
  const kept = crontabText(input).split(/\n/).filter((row) => row && !row.includes(marker));
  runHost(input, "crontab", ["-"], { input: kept.length ? `${kept.join("\n")}\n` : "" });
  return { kind: "cron", installed: false, tickEvery: null };
}
