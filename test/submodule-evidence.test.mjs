import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { assertWorktreeMatchesHead, changedFiles, git, snapshot } from "../skills/spec/scripts/evidence.mjs";
import { trashFixture } from "./helpers/cleanup.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) trashFixture(root); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rusubon-submodule-")); roots.push(root);
  const repo = join(root, "parent"); const source = join(root, "source");
  for (const dir of [repo, source]) {
    mkdirSync(dir); git(dir, ["init", "-b", "main"]);
    git(dir, ["config", "user.name", "Test"]); git(dir, ["config", "user.email", "test@example.test"]);
    writeFileSync(join(dir, "code.txt"), "original");
    git(dir, ["add", "."]); git(dir, ["commit", "-m", "initial"]);
  }
  const name = "deps/library with spaces";
  git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", source, name]);
  git(repo, ["commit", "-am", "add submodule"]);
  return { root, repo, source, name, sub: join(repo, name) };
}

test("clean submodule commits are fingerprinted and stay stable through staging and commit", () => {
  const f = fixture(); const before = snapshot(f.repo);
  assert.equal(before.files[f.name], `gitlink:${git(f.sub, ["rev-parse", "HEAD"])}`);
  writeFileSync(join(f.source, "code.txt"), "updated");
  git(f.source, ["commit", "-am", "update"]);
  git(f.sub, ["fetch", "origin"]); git(f.sub, ["checkout", "--detach", "origin/main"]);
  const changed = snapshot(f.repo);
  assert.deepEqual(changedFiles(before, changed), [f.name]);
  git(f.repo, ["add", f.name]);
  assert.equal(snapshot(f.repo).digest, changed.digest);
  git(f.repo, ["commit", "-m", "update submodule"]);
  assert.equal(snapshot(f.repo).digest, changed.digest);
});

test("submodule tracked edits and untracked files cannot be certified", () => {
  const f = fixture();
  writeFileSync(join(f.sub, "code.txt"), "dirty");
  assert.throws(() => snapshot(f.repo), /submodule has uncommitted changes/);
  writeFileSync(join(f.sub, "code.txt"), "original");
  writeFileSync(join(f.sub, "untracked.txt"), "dirty");
  assert.throws(() => snapshot(f.repo), /submodule has uncommitted changes/);
});

test("uninitialized submodules retain the gitlink without reading unrelated content", () => {
  const f = fixture(); const before = snapshot(f.repo);
  renameSync(f.sub, join(f.root, "saved-checkout"));
  assert.equal(snapshot(f.repo).digest, before.digest);
  assertWorktreeMatchesHead(f.repo);
  mkdirSync(f.sub);
  assert.equal(snapshot(f.repo).digest, before.digest);
  assertWorktreeMatchesHead(f.repo);
  writeFileSync(join(f.sub, "unknown.txt"), "untracked checkout content");
  assert.throws(() => snapshot(f.repo), /content without a checkout/);
});

test("hidden edits inside submodules invalidate snapshots and clean-checkout checks", () => {
  const f = fixture();
  git(f.sub, ["update-index", "--assume-unchanged", "code.txt"]);
  writeFileSync(join(f.sub, "code.txt"), "hidden edit");
  assert.equal(git(f.repo, ["status", "--porcelain"]), "");
  assert.throws(() => snapshot(f.repo), /worktree.*HEAD/);
  assert.throws(() => assertWorktreeMatchesHead(f.repo), /worktree.*HEAD/);
});

test("HEAD comparisons honor repository line-ending conversion", () => {
  const f = fixture();
  writeFileSync(join(f.repo, ".gitattributes"), "code.txt text eol=crlf\n");
  writeFileSync(join(f.repo, "code.txt"), "line one\r\nline two\r\n");
  git(f.repo, ["add", ".gitattributes", "code.txt"]);
  git(f.repo, ["commit", "-m", "line endings"]);
  assertWorktreeMatchesHead(f.repo);
});

test("HEAD comparisons detect executable-bit changes hidden by Git configuration", () => {
  const f = fixture();
  git(f.repo, ["config", "core.filemode", "false"]);
  chmodSync(join(f.repo, "code.txt"), 0o755);
  assert.equal(git(f.repo, ["status", "--porcelain"]), "");
  assert.throws(() => assertWorktreeMatchesHead(f.repo), /worktree.*HEAD/);
});
