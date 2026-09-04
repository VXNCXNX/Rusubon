import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PLACEHOLDER, loadContext } from "./context.mjs";
import { assertPrReady } from "./doctor.mjs";
import { cwd, runsDir } from "./paths.mjs";
import { formatIssueRef, parseSource, resolveSource } from "./pr-source.mjs";
import { loadSkill } from "./run.mjs";
import { runWith } from "./runners.mjs";

function optionalContext() {
  try {
    const { body } = loadContext();
    if (!body.trim() || body.includes(PLACEHOLDER)) return "";
    return body.trim();
  } catch {
    return "";
  }
}

function formatSource(source) {
  if (source.kind === "issue") {
    const lines = [`kind: issue`, `ref: ${formatIssueRef(source)}`];
    if (source.url) lines.push(`url: ${source.url}`);
    if (source.state) lines.push(`state: ${source.state}`);
    const labels = Array.isArray(source.labels)
      ? source.labels.map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean).join(", ")
      : "";
    if (labels) lines.push(`labels: ${labels}`);
    if (source.title) lines.push(`title: ${source.title}`);
    lines.push("", source.body || "");
    return lines.join("\n");
  }
  const lines = [`kind: report`, `slug: ${source.slug}`];
  if (source.path) lines.push(`path: ${source.path}`);
  if (source.title) lines.push(`title: ${source.title}`);
  lines.push("", source.body || "");
  return lines.join("\n");
}

export function buildPrPrompt(source, config, extras = {}) {
  const research = extras.research || loadSkill("research");
  const writing = extras.writing || loadSkill("writing-pr-descriptions");
  const context = extras.context !== undefined ? extras.context : optionalContext();
  const today = new Date().toISOString().slice(0, 10);
  const runFile = `.rusubon/runs/${today}-research.md`;
  const contextBlock = context
    ? `# Product context\nHuman-authored. Advisory. Optional on this door.\n\n${context}\n\n`
    : "";

  return `You are running a Rusubon research pass. A human launched \`rusubon pr\`. This is not a scout.

${contextBlock}# Source
${formatSource(source)}

# Harness
- Working directory: ${cwd()}
- Runner: ${config?.runner || "claude"}
- Close-out: ${runFile}
- Draft via \`gh pr create --draft\`. Never merge. Never \`gh pr merge\`.
- Shape the PR body in five passes (lead, route, cut, shape, check).
- Always Read the writing-pr-descriptions skill in full before \`gh pr create\`.
- Public PRs: no Slack quotes, no customer names, no customer data.
- Write the close-out even if you do not open a PR.

# Skill: research
${research.body || research}

# Skill: writing-pr-descriptions
Read this in full before \`gh pr create\`.

${writing.body || writing}
`;
}

export async function runPr({ raw, flags, config, probes }) {
  assertPrReady(config, probes);
  const parsed = parseSource(raw, flags);
  const source = resolveSource(parsed, probes);
  mkdirSync(runsDir(), { recursive: true });
  const prompt = buildPrPrompt(source, config);
  writeFileSync(resolve(runsDir(), "last-prompt-pr.md"), prompt);

  const label = source.kind === "issue" ? formatIssueRef(source) : source.slug;
  console.log(`research  ${label}`);

  const result = runWith(config.runner, prompt);
  if (result.status !== 0) {
    throw new Error(`${config.runner} exited ${result.status}`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const closeRel = `.rusubon/runs/${today}-research.md`;
  if (!existsSync(resolve(cwd(), closeRel))) {
    throw new Error(`research did not write ${closeRel}`);
  }
  console.log(`close-out ${closeRel}`);
}
