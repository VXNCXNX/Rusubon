import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Jobs } from "../../src/ui/jobs.mjs";
const context = process.argv.includes("context");
const jobs = new Jobs(process.cwd(), { worker: fileURLToPath(new URL(context ? "./ui-context-worker.mjs" : "./ui-worker.mjs", import.meta.url)) });
const job = jobs.start({ kind: context ? "context" : "pr", selection: { runner: "codex", model: "gpt-5.6-luna", effort: "low" }, source: { kind: "issue", value: "#1" } });
writeFileSync("worker.pid", String(jobs.active.get(job.id).child.pid));
setInterval(() => {}, 1000);
