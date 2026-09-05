import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { trashFixture } from "./helpers/cleanup.mjs";

test("cleanup terminates a trash executable that handles SIGTERM without exiting", () => {
  const root = mkdtempSync(join(tmpdir(), "rusubon-trash-test-"));
  const originalPath = process.env.PATH;
  const originalWarn = console.warn;
  const warnings = [];
  const ready = join(root, "ready");
  const handled = join(root, "handled-term");
  writeFileSync(join(root, "trash"), `#!${process.execPath}
const {writeFileSync} = require('node:fs');
process.on('SIGTERM', () => writeFileSync(${JSON.stringify(handled)}, 'handled'));
writeFileSync(${JSON.stringify(ready)}, 'ready');
setTimeout(() => process.exit(0), 2000);
`, { mode: 0o755 });
  try {
    process.env.PATH = root;
    console.warn = (message) => warnings.push(message);
    trashFixture(join(root, "fixture"), 500);
    assert.ok(existsSync(ready), "trash reached its signal handler setup");
    assert.ok(!existsSync(handled), "timeout must not rely on catchable SIGTERM");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /ETIMEDOUT.*retained test fixture/);
  } finally {
    process.env.PATH = originalPath;
    console.warn = originalWarn;
    trashFixture(root);
  }
});
