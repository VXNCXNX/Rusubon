import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { localPath, readLocal, renderMarkdown } from "./workspace.mjs";

export function artifacts(repo, job) {
  const entries = [], seen = new Set();
  const add = (root, dir, prefix) => {
    if (!dir || !existsSync(localPath(root, dir))) return;
    for (const name of readdirSync(localPath(root, dir))) {
      if (!/\.(md|json|log)$/.test(name) || name === "job.json") continue;
      const path = `${dir}/${name}`;
      try {
        const file = localPath(root, path); if (!statSync(file).isFile() || statSync(file).size > 1_000_000 || seen.has(file)) continue;
        seen.add(file); entries.push({ key: `${prefix}/${name}`, label: `${prefix} / ${name}`, root, path });
      } catch { /* Do not expose symlinked or oversized artifacts. */ }
    }
  };
  add(repo, `.rusubon/runs/${job.id}`, "Run");
  const worktreeEvent = job.events?.find(event => event.type === "worktree");
  const root = job.result?.worktree || job.worktree || worktreeEvent?.path || repo;
  const closeOut = job.result?.closeOut || job.workflowArtifacts?.closeOut;
  const specPath = job.result?.specPath || job.workflowArtifacts?.specPath;
  if (closeOut) add(root, relative(root, dirname(resolve(root, closeOut))), "Workflow");
  if (specPath) add(root, specPath, "Spec");
  return entries;
}

export function readArtifact(repo, job, key) {
  const entry = artifacts(repo, job).find(row => row.key === key);
  if (!entry) throw new Error("Artifact not found");
  const body = readLocal(entry.root, entry.path);
  return { key, label: entry.label, body, html: entry.path.endsWith(".md") ? renderMarkdown(body) : null };
}
