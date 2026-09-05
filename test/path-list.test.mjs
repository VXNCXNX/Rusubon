import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePathList } from "../skills/spec/scripts/path-list.mjs";
import { parseTasks } from "../skills/spec/scripts/tasks.mjs";

test("quoted commas and backticks remain part of the exact path", () => {
  const text = "`src/data,legacy.mjs`, ``test/a`b.mjs``, plain.mjs";
  assert.deepEqual(parsePathList(text), ["src/data,legacy.mjs", "test/a`b.mjs", "plain.mjs"]);
  assert.deepEqual(parsePathList("``a```b``, ` spaced name `"), ["a```b", " spaced name "]);
  const parsed = parseTasks(`- [ ] Fix\nFiles: ${text}\nVerify: check\n`);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.tasks[0].files, parsePathList(text));
});

test("JSON arrays preserve punctuation, whitespace and escaped characters", () => {
  const names = ["data,legacy.mjs", "a`b.mjs", "name[1]*.mjs", ":(glob)*", " spaced ", "new\nline", "back\\slash"];
  assert.deepEqual(parsePathList(JSON.stringify(names)), names);
});

test("ambiguous or incomplete path declarations fail instead of changing the path", () => {
  for (const text of ["", "a,", ",a", "a,,b", "`a", "a`", "`a` b", "[]", '["a",null]', '["a",""]']) {
    assert.throws(() => parsePathList(text), undefined, text);
    assert.ok(parseTasks(`- [ ] Fix\nFiles: ${text}\n`).problems.length, text);
  }
});
