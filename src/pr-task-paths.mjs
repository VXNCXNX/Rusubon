import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { git, localPath } from "../skills/spec/scripts/evidence.mjs";

export function assertPublishableTaskPaths(repo, declarations) {
  const gitDirs = ["--git-dir", "--git-common-dir"].map((option) =>
    realpathSync(resolve(repo, git(repo, ["rev-parse", option]))));
  const paths = [...new Set(declarations.map((path) => {
    // Git reserves .git at every depth, including worktrees where it is a file.
    if (path.split(/[\\/]/).some((part) => part.toLowerCase() === ".git")) {
      throw new Error(`Git-administrative task path cannot be published: ${path}`);
    }
    const full = localPath(repo, path);
    let ancestor = full;
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    const real = realpathSync(ancestor);
    // Cover symlink aliases and relocated Git directories, not only the .git name.
    if (gitDirs.some((dir) => real === dir || real.startsWith(dir + sep))) {
      throw new Error(`Git-administrative task path cannot be published: ${path}`);
    }
    return relative(repo, full);
  }))];
  if (paths.some((path) => path === ".rusubon/runs" || path.startsWith(".rusubon/runs/"))) {
    throw new Error("task files cannot use the harness run-artifact directory");
  }
  // Tracked files remain eligible when ignore rules match. Recheck on every
  // validation so implementation cannot introduce new exclusions.
  const ignored = spawnSync("git", ["check-ignore", "--stdin", "-z"], {
    cwd: repo, input: paths.join("\0") + "\0", encoding: "utf8", timeout: 30000,
  });
  if (ignored.status === 0) throw new Error(`ignored task files cannot be published: ${ignored.stdout.split("\0").filter(Boolean).join(", ")}`);
  if (ignored.status !== 1) throw new Error(`cannot check task file visibility: ${ignored.stderr || ignored.error?.message || ignored.status}`);
}
