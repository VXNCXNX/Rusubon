import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

export const hash = (value) => createHash("sha256").update(value).digest("hex");

export function git(repo, args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr || result.error?.message || result.status}`);
  return result.stdout.trimEnd();
}

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

export function snapshot(repo) {
  const names = git(repo, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean);
  const files = Object.create(null);
  for (const name of [...new Set(names)].sort()) {
    if (name.startsWith(".rusubon/runs/")) continue;
    const full = join(repo, name);
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

export function changedFiles(before, after) {
  return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
    .filter((path) => before.files[path] !== after.files[path]).sort();
}

export function planHash(dir) {
  const state = JSON.parse(readFileSync(join(dir, ".spec-state.json"), "utf8"));
  delete state.closure;
  const files = ["requirements.md", "tasks.md", ...(state.type === "quick" ? [] : ["design.md"])];
  return hash(JSON.stringify({ state, files: files.map((file) => {
    const text = readFileSync(join(dir, file), "utf8");
    return [file, file === "tasks.md" ? text.replace(/^(\s*-\s*\[)[xX](\])/gm, "$1 $2") : text];
  }) }));
}

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
