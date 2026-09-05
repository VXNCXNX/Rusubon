import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

/** Return a SHA-256 content digest for a string or buffer. */
export const hash = (value) => createHash("sha256").update(value).digest("hex");

/** List the only permitted spec files for a quick, bug or feature plan. */
export const specFiles = (type) => ["requirements.md", "tasks.md", ".spec-state.json",
  ...(type === "quick" ? [] : ["design.md"])];

/** Run Git in a checkout with an optional environment and return stdout without trailing whitespace.
 * Throw on failure; NUL-delimited filename output retains its terminal NUL. */
export function git(repo, args, env) {
  const result = spawnSync("git", args, { cwd: repo, env, encoding: "utf8", timeout: 120000, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr || result.error?.message || result.status}`);
  return result.stdout.trimEnd();
}

/** Compare tracked contents with HEAD using an independent index and Git content filters.
 * Reject hidden edits and dirty submodules while preserving the checkout index flags. */
export function assertWorktreeMatchesHead(repo) {
  // A fresh index has no assume-unchanged or skip-worktree flags. Git still
  // applies the repository's normal content filters, including line endings.
  const index = join(tmpdir(), `rusubon-index-${randomUUID()}`);
  writeFileSync(index, "", { flag: "wx", mode: 0o600 });
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const config = ["-c", "core.sparseCheckout=false", "-c", "core.splitIndex=false",
    "-c", "core.ignoreStat=false", "-c", "core.fsmonitor=false", "-c", "core.filemode=true"];
  try {
    git(repo, [...config, "read-tree", "HEAD"], env);
    const differences = git(repo, [...config, "diff", "--name-only", "--no-ext-diff", "--ignore-submodules=all", "HEAD", "--"], env);
    if (differences) throw new Error(`tracked worktree differs from HEAD: ${differences}`);
  } finally {
    // Only this call's disposable index is removed; the checkout index is untouched.
    unlinkSync(index);
  }
  for (const entry of git(repo, ["ls-tree", "-r", "-z", "HEAD"]).split("\0")) {
    if (!entry.startsWith("160000 ")) continue;
    const tab = entry.indexOf("\t");
    const name = entry.slice(tab + 1);
    const commit = entry.slice(0, tab).split(" ")[2];
    // Git's fresh-index diff treats absent submodules as deletions. Check their
    // commits explicitly so deinitialized checkouts remain supported.
    if (submoduleCommit(join(repo, name), name, commit) !== commit) {
      throw new Error(`tracked worktree differs from HEAD: ${name}`);
    }
  }
}

/** Resolve a repo-relative path and reject traversal or existing symlink escapes. */
export function localPath(repo, path) {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\0")) throw new Error("expected a repository-relative path");
  const full = resolve(repo, path);
  const rel = relative(repo, full);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`path leaves repository: ${path}`);
  // Check existing ancestors too, so a new file under a symlink cannot escape.
  let ancestor = full;
  while (true) {
    try {
      const real = realpathSync(ancestor);
      const outside = relative(realpathSync(repo), real);
      if (outside === ".." || outside.startsWith(`..${sep}`)) throw new Error(`path leaves repository: ${path}`);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      ancestor = resolve(ancestor, "..");
    }
  }
  return full;
}

/** Fingerprint Git-visible files and clean submodule commits, excluding harness run artifacts. */
export function snapshot(repo) {
  const names = git(repo, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean);
  const gitlinks = new Map(git(repo, ["ls-files", "--stage", "-z"]).split("\0")
    .filter((entry) => entry.startsWith("160000 ")).map((entry) => {
      const tab = entry.indexOf("\t");
      const [, commit, stage] = entry.slice(0, tab).split(" ");
      if (stage !== "0") throw new Error("cannot snapshot an unresolved submodule conflict");
      return [entry.slice(tab + 1), commit];
    }));
  const files = Object.create(null);
  for (const name of [...new Set(names)].sort()) {
    if (name.startsWith(".rusubon/runs/")) continue;
    const full = join(repo, name);
    if (gitlinks.has(name)) {
      files[name] = `gitlink:${submoduleCommit(full, name, gitlinks.get(name))}`;
      continue;
    }
    try {
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) files[name] = `link:${readlinkSync(full)}`;
      else if (stat.isFile()) files[name] = `${stat.mode & 0o111}:${hash(readFileSync(full))}`;
      else throw new Error(`unsupported tracked path: ${name}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return { files, digest: hash(JSON.stringify(files)) };
}

/** Return a clean submodule revision or its indexed commit when uninitialized.
 * Reject dirty, mismatched or partially populated submodule checkouts. */
function submoduleCommit(full, name, indexedCommit) {
  if (!existsSync(full)) return indexedCommit;
  if (!lstatSync(full).isDirectory()) throw new Error(`submodule is not a directory: ${name}`);
  // Deinitialized submodules have no checkout, so retain the indexed gitlink.
  if (!existsSync(join(full, ".git"))) {
    if (readdirSync(full).length) throw new Error(`submodule has content without a checkout: ${name}`);
    return indexedCommit;
  }
  if (realpathSync(git(full, ["rev-parse", "--show-toplevel"])) !== realpathSync(full)) {
    throw new Error(`submodule checkout does not match its path: ${name}`);
  }
  if (git(full, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"])) {
    throw new Error(`submodule has uncommitted changes: ${name}`);
  }
  assertWorktreeMatchesHead(full);
  return git(full, ["rev-parse", "HEAD"]);
}

/** Return sorted paths whose fingerprints differ, including additions and removals. */
export function changedFiles(before, after) {
  return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
    .filter((path) => before.files[path] !== after.files[path]).sort();
}

/** Hash the spec while excluding task completion checkmarks and implementation closure. */
export function planHash(dir) {
  const state = JSON.parse(readFileSync(join(dir, ".spec-state.json"), "utf8"));
  delete state.closure;
  const files = specFiles(state.type).filter((name) => name !== ".spec-state.json");
  return hash(JSON.stringify({ state, files: files.map((file) => {
    const text = readFileSync(join(dir, file), "utf8");
    return [file, file === "tasks.md" ? text.replace(/^(\s*-\s*\[)[xX](\])/gm, "$1 $2") : text];
  }) }));
}

/** Reject receipts that do not match the current run, spec, code and verification logs. */
export function assertReceipt(repo, dir, receipt) {
  const state = JSON.parse(readFileSync(join(dir, ".spec-state.json"), "utf8"));
  if (receipt?.version !== 1 || receipt.run_id !== state.run_id || receipt.source !== state.source
      || receipt.plan_hash !== planHash(dir) || receipt.tree_hash !== snapshot(repo).digest) {
    throw new Error("verification receipt does not match this run, spec and code");
  }
  if (!Array.isArray(receipt.commands) || receipt.commands.length !== state.verification.length) {
    throw new Error("verification receipt does not cover every command");
  }
  for (const [index, command] of state.verification.entries()) {
    const result = receipt.commands[index];
    if (result?.id !== command.id || JSON.stringify(result.argv) !== JSON.stringify(command.argv)
        || result.cwd !== command.cwd || result.exit_code !== 0 || result.kind !== command.kind
        || (command.kind === "test" && !(result.passed > 0))) {
      throw new Error(`missing passing evidence for ${command.id}`);
    }
    if (hash(readFileSync(localPath(repo, result.log))) !== result.log_hash) {
      throw new Error(`verification log changed for ${command.id}`);
    }
  }
}
