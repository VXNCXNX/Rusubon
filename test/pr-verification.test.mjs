import assert from "node:assert/strict";
import { test } from "node:test";
import { passingTap } from "../src/pr-verification.mjs";

test("TAP receipts reject incomplete, contradictory and malformed plans", () => {
  for (const body of [
    "ok 1 - only\n1..2\n",
    "1..0\nok 1 - unexpected\n",
    "ok 1 - first\nok 1 - duplicate\n1..2\n",
    "ok 2 - out of range\n1..1\n",
    "ok 1 - missing plan\n",
    "1..1\nok 1 - first\n1..1\n",
    "ok 1 - first\n1..1\nBail out! stopped\n",
    "not ok 1 - failure\n1..1\n",
    "ok 1 - first\n1..1\nnot TAP\n",
    "# Subtest: suite\n    ok 1 - only\n    1..2\nok 1 - suite\n1..1\n",
  ]) {
    assert.throws(() => passingTap(`TAP version 13\n${body}`), /did not produce passing TAP/, body);
  }
});

test("TAP receipts count passing leaf cases with valid plans and diagnostics", () => {
  const tap = "TAP version 13\n# Subtest: suite\n"
    + "    ok 1 - first\n      ---\n      duration_ms: 1\n      ...\n"
    + "    ok 2 - skipped # SKIP later\n    not ok 3 - todo # TODO later\n"
    + "    ok 4 - second\n    1..4\nok 1 - suite\n1..1\n";
  assert.equal(passingTap(tap), 2);
  assert.equal(passingTap("> app@1 test\n> node --test\n\n" + tap), 2);
  assert.equal(passingTap("TAP version 14\n1..1\nok 1 - first"), 1);
});

test("empty and skipped TAP streams cannot issue passing receipts", () => {
  for (const body of ["1..0 # no tests\n", "ok 1 - skipped # SKIP later\n1..1\n",
    "not ok 1 - todo # TODO later\n1..1\n", "ok 1 - suite\n  ---\n  type: suite\n  ...\n1..1\n"]) {
    assert.throws(() => passingTap(`TAP version 13\n${body}`), /no named test/);
  }
});

test("test names are labels even when they match repository paths", () => {
  for (const name of ["package.json", "test", "test/pr-verification.test.mjs"]) {
    assert.equal(passingTap(`TAP version 13\nok 1 - ${name}\n1..1\n`), 1);
    assert.equal(passingTap("TAP version 13\n# Subtest: parent\n"
      + `    ok 1 - ${name}\n    1..1\nok 1 - parent\n1..1\n`), 1);
  }
});
