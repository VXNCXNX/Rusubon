import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnBoundedSync } from "../skills/spec/scripts/process.mjs";
import { trashFixture } from "./helpers/cleanup.mjs";

/** Distinguish runnable descendants from killed processes awaiting OS reaping. */
function running(pid) {
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() && !result.stdout.trim().startsWith("Z");
}

for (const signal of ["SIGINT", "SIGTERM", "SIGKILL"]) {
  test(`caller ${signal} stops its supervisor and descendants before the command deadline`, { skip: process.platform === "win32", timeout: 10000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "rusubon-cancel-test-"));
    const marker = join(dir, "pids");
    const descendant = `require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,process.ppid,Number(process.argv[1])]));
process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setTimeout(()=>{},30000);`;
    const command = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)},String(process.ppid)],{stdio:'inherit'});
process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setTimeout(()=>{},30000);`;
    const script = `import {spawnBoundedSync} from ${JSON.stringify(new URL("../skills/spec/scripts/process.mjs", import.meta.url).href)};
spawnBoundedSync(process.execPath,['-e',${JSON.stringify(command)}],{timeout:30000});`;
    const caller = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore", env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir } });
    let pids = [];
    try {
      for (let attempts = 0; attempts < 100 && !existsSync(marker); attempts++) await new Promise((resolve) => setTimeout(resolve, 25));
      assert.ok(existsSync(marker), "supervised descendant started before interruption");
      pids = JSON.parse(readFileSync(marker, "utf8"));
      assert.equal(readdirSync(dir).filter((name) => name.startsWith("rusubon-process-")).length, 1);
      caller.kill(signal);
      for (let attempts = 0; attempts < 40 && [caller.pid, ...pids].some(running); attempts++) await new Promise((resolve) => setTimeout(resolve, 25));
      assert.ok(!running(caller.pid), "caller stopped");
      assert.ok(pids.every((pid) => !running(pid)), "supervisor and both descendants stopped promptly, without waiting for the deadline");
      assert.deepEqual(readdirSync(dir), ["pids"], "orphaned supervisor removes its private request and response files");
    } finally {
      if (running(caller.pid)) caller.kill("SIGKILL");
      if (!pids.length && existsSync(marker)) pids = JSON.parse(readFileSync(marker, "utf8"));
      for (const pid of pids) {
        try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      trashFixture(dir);
    }
  });
}

for (const mode of ["timeout", "output overflow", "normal exit"]) {
  test(`supervised ${mode} terminates descendants holding captured output pipes`, { skip: process.platform === "win32" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "rusubon-group-test-"));
    const marker = join(dir, "pid");
    const child = `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));
process.on('SIGTERM',()=>{});
${mode === "output overflow" ? "process.stdout.write('x'.repeat(100000));" : ""}
setTimeout(()=>process.exit(0),10000);`;
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'});
${mode === "normal exit"
  ? `const poll=setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(marker)})){clearInterval(poll);process.exit(7)}},10);`
  : "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),10000);"}`;
    let pid;
    try {
      const result = spawnBoundedSync(process.execPath, ["-e", parent], {
        encoding: "utf8", timeout: 2000, maxBuffer: mode === "output overflow" ? 1024 : 1024 * 1024,
      });
      assert.ok(existsSync(marker), "descendant started before termination");
      pid = Number(readFileSync(marker, "utf8"));
      for (let attempts = 0; attempts < 20 && running(pid); attempts++) await new Promise((resolve) => setTimeout(resolve, 25));
      assert.ok(!running(pid), "descendant must stop with its supervised command");
      if (mode === "normal exit") assert.equal(result.status, 7);
      else assert.equal(result.error?.code, mode === "timeout" ? "ETIMEDOUT" : "ENOBUFS");
    } finally {
      if (pid && running(pid)) process.kill(pid, "SIGKILL");
      trashFixture(dir);
    }
  });
}

test("supervised commands preserve stdin, stdout, stderr, exit codes and spawn failures", () => {
  const result = spawnBoundedSync(process.execPath, ["-e", "process.stdout.write(require('node:fs').readFileSync(0));process.stderr.write('diagnostic');process.exit(3)"], {
    input: "body from stdin", encoding: "utf8", timeout: 2000,
  });
  assert.equal(result.status, 3);
  assert.equal(result.stdout, "body from stdin");
  assert.equal(result.stderr, "diagnostic");
  assert.equal(result.error, undefined);
  const missing = spawnBoundedSync(join(tmpdir(), "rusubon-no-such-executable"), [], { encoding: "utf8", timeout: 2000 });
  assert.equal(missing.error?.code, "ENOENT");
});

test("native Windows rejects timed commands before launching a supervisor or child", () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    assert.throws(() => spawnBoundedSync(process.execPath, ["-e", "process.exit(0)"], { timeout: 1000 }), /WSL/);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});
