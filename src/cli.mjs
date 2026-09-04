import { takeFlag, takeOption, readStdin } from "./argv.mjs";
import { initConfig, loadConfig, CONFIG_NAME } from "./config.mjs";
import { draftContext } from "./context-draft.mjs";
import { decline } from "./decline.mjs";
import { collectChecks, formatDoctor } from "./doctor.mjs";
import { listInbox, printInbox, printShow, showReport } from "./inbox.mjs";
import { remember } from "./memory.mjs";
import { runPr } from "./pr.mjs";
import { listSkills, runSkill } from "./run.mjs";
import { RUNNERS } from "./runners.mjs";

const HELP = `Rusubon — 留守番 — product scouts for PostHog, on your own agent.

Usage:
  rusubon init                         scaffold .rusubon/ + ${CONFIG_NAME}
  rusubon context draft [--about "…"] [--force]
                                       propose context.md (placeholder stays)
  rusubon doctor                       preflight before a run
  rusubon run <skill>                  run a scout (friction)
  rusubon pr <slug|#N|url> [--issue|--report]
                                       research, auto-spec, verify; draft PR
  rusubon inbox                        list open reports
  rusubon show <slug>                  print a report (open or archived)
  rusubon decline <slug> --why "…"     archive a report + write memory/noise
  rusubon remember <prefix/slug> […]   upsert .rusubon/memory/<prefix>/<slug>.md
  rusubon skills                       list bundled skills
  rusubon runners                      show runner status
  rusubon help
`;

function doctorCommand() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.log(formatDoctor([{ name: "config", ok: false, detail: err.message }]));
    process.exitCode = 1;
    return;
  }
  const checks = collectChecks(config);
  console.log(formatDoctor(checks));
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "init":
      return initConfig();
    case "context": {
      if (rest[0] !== "draft") {
        throw new Error('usage: rusubon context draft [--about "…"] [--force]');
      }
      const force = takeFlag(rest.slice(1), "force");
      const aboutOpt = takeOption(force.rest, "about");
      let about = (aboutOpt.value || aboutOpt.rest.join(" ")).trim();
      if (!about) about = (await readStdin()).trim();
      return draftContext({ about, force: force.present });
    }
    case "doctor":
      return doctorCommand();
    case "run": {
      const skill = rest[0];
      if (!skill) throw new Error("usage: rusubon run <skill>");
      if (skill === "research") {
        throw new Error("research is not a scout. launch it with `rusubon pr <slug|issue>`");
      }
      const config = loadConfig();
      return runSkill(skill, config);
    }
    case "pr": {
      const issue = takeFlag(rest, "issue");
      const report = takeFlag(issue.rest, "report");
      const raw = report.rest[0];
      if (!raw) throw new Error("usage: rusubon pr <slug|#N|url> [--issue|--report]");
      const config = loadConfig();
      return runPr({
        raw,
        flags: { issue: issue.present, report: report.present },
        config,
      });
    }
    case "remember": {
      const key = rest[0];
      if (!key) throw new Error("usage: rusubon remember <prefix/slug> [text]");
      let content = rest.slice(1).join(" ").trim();
      if (!content) content = (await readStdin()).trim();
      const result = remember(key, content);
      console.log(`wrote .rusubon/memory/${result.key}.md`);
      return;
    }
    case "decline": {
      const parsed = takeOption(rest, "why");
      const slug = parsed.rest[0];
      if (!slug || !parsed.value) {
        throw new Error('usage: rusubon decline <slug> --why "…"');
      }
      const result = decline(slug, parsed.value);
      console.log(`archived ${result.slug}; wrote .rusubon/memory/noise/${result.slug}.md`);
      return;
    }
    case "inbox":
      return printInbox(listInbox());
    case "show": {
      const slug = rest[0];
      if (!slug) throw new Error("usage: rusubon show <slug>");
      return printShow(showReport(slug));
    }
    case "skills":
      for (const name of listSkills()) console.log(name);
      return;
    case "runners":
      for (const [name, spec] of Object.entries(RUNNERS)) {
        const ok = spec.which();
        console.log(`${name.padEnd(8)} ${ok ? ok : "not found"}`);
      }
      return;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(HELP);
      return;
    default:
      throw new Error(`unknown command: ${cmd}\n\n${HELP}`);
  }
}
