import assert from "node:assert/strict";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { assertPublishableTaskPaths } from "../src/pr-task-paths.mjs";
import { git } from "../skills/spec/scripts/evidence.mjs";
import { fixture } from "./helpers/pr-fixture.mjs";

const fixtures = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
function setup() { const f = fixture(); fixtures.push(f); return f; }

test("task paths reject symlink aliases into Git administration", () => {
  const f = setup();
  symlinkSync(".git", join(f.repo, "admin-alias"));
  for (const path of ["admin-alias", "admin-alias/config", "admin-alias/hooks/new-hook"]) {
    assert.throws(() => assertPublishableTaskPaths(f.repo, [path]), /Git-administrative task path/);
  }
});

test("relocated Git directories remain outside the task file boundary", () => {
  const f = setup();
  git(f.repo, ["init", "--separate-git-dir", join(f.repo, "git-metadata")]);
  for (const path of ["git-metadata", "git-metadata/config", "git-metadata/hooks/new-hook"]) {
    assert.throws(() => assertPublishableTaskPaths(f.repo, [path]), /Git-administrative task path/);
  }
});

test("linked worktrees reject their .git pointer while allowing normal Git project files", () => {
  const f = setup(); const linked = join(f.root, "linked");
  git(f.repo, ["worktree", "add", "-b", "linked", linked]);
  for (const path of [".git", ".git/config", "nested/.git/hooks/pre-commit"]) {
    assert.throws(() => assertPublishableTaskPaths(linked, [path]), /Git-administrative task path/);
  }
  assertPublishableTaskPaths(linked, [".gitignore", ".gitattributes", ".gitmodules", ".github/workflows/test.yml"]);
});
