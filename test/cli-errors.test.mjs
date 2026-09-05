import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("CLI errors redact credentials even before a workflow starts", () => {
  for (const prefix of ["ph" + "c_", "ph" + "x_"]) {
    const secret = prefix + "TESTONLYNOTAREALCREDENTIAL";
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/rusubon.mjs", import.meta.url)), "show", secret], {
      encoding: "utf8", timeout: 10000, killSignal: "SIGKILL",
    });
    assert.equal(result.status, 1);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(secret), "terminal error must redact credentials");
    assert.ok(result.stderr.includes(`${prefix}REDACTED`));
  }
});
