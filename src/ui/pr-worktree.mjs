import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { command, mustCommand } from "./process.mjs";
import { reportDetail, writeLocal } from "./workspace.mjs";

/** Prepare committed code without disturbing the caller's checkout. */
export async function preparePr(repo, source, id, { signal, emit = () => {}, worktreeRoot = join(homedir(), ".rusubon", "worktrees") } = {}) {
  if (!/^ui-[a-f0-9-]+$/.test(id)) throw new Error("Invalid worktree run id");
  const base = await mustCommand("git", ["branch", "--show-current"], { cwd: repo, signal });
  if (!base) throw new Error("Select a named base branch before launching a draft PR");
  const head = await mustCommand("git", ["rev-parse", "HEAD"], { cwd: repo, signal });
  const remote = await mustCommand("git", ["ls-remote", "--exit-code", "origin", `refs/heads/${base}`], { cwd: repo, signal });
  if (remote.split(/\s+/)[0] !== head) throw new Error("The base branch must match origin. Push or update it before launching a draft PR.");
  const root = join(worktreeRoot, createHash("sha256").update(repo).digest("hex").slice(0, 16));
  mkdirSync(root, { recursive: true });
  const worktree = join(root, id);
  emit({ type: "phase", name: "Prepare worktree", status: "running" });
  await mustCommand("git", ["worktree", "add", "-b", `codex-ui-base-${id.slice(3)}`, worktree, head], { cwd: repo, signal });
  emit({ type: "worktree", path: worktree, base, head });
  const ignored = await command("git", ["check-ignore", ".rusubon/inbox/reports/check.md", ".rusubon/runs/check.md"], { cwd: worktree, signal });
  if (ignored.code !== 0 || ignored.output.split("\n").length !== 2) throw new Error(`Commit the Rusubon .gitignore setup on ${base} before creating a PR. Prepared checkout: ${worktree}`);
  if (source.kind === "report") {
    const report = reportDetail(repo, source.value);
    writeLocal(worktree, `.rusubon/inbox/reports/${report.slug}.md`, report.body);
  }
  emit({ type: "phase", name: "Prepare worktree", status: "completed", path: worktree });
  return { worktree, base };
}
