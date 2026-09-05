import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
