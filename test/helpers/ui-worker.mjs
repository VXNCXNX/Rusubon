import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { saveSetup } from "../../src/ui/workspace.mjs";

let job;
const send = message => process.connected && process.send(message);
const done = result => process.send({ type: "result", result }, () => process.exit(0));
process.on("message", message => {
  if (message.type === "start") {
    job = message.input;
    send({ type: "started" });
    send({ type: "event", event: { type: "phase", name: "SQL analysis", status: "running" } });
    send({ type: "event", event: { type: "message", text: "Checking the checkout funnel with event evidence." } });
    send({ type: "event", event: { type: "tool", name: "PostHog SQL", text: "Authorization: Bearer secret-value\nphc_fakeSecretValue" } });
    if (job.kind === "scout") {
      send({ type: "request", request: job.selection.model === "gpt-6-astra"
        ? { id: "approval-1", kind: "questions", title: "Confirm the comparison window", questions: [{ id: "window", question: "Which comparison window should this run use?", options: [{ label: "Last 14 days", description: "Compare against the recent baseline." }, { label: "Last 7 days", description: "Use the most recent week." }] }] }
        : { id: "approval-1", kind: "permission", title: "Query event evidence", input: { query: "SELECT count() FROM events", authorization: "Bearer secret-value" } } });
    } else if (job.kind === "pr") {
      const descendant = spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'], { stdio: "inherit" });
      writeFileSync("descendant.pid", String(descendant.pid));
      send({ type: "event", event: { type: "message", text: "Long-running child started" } });
      setInterval(() => {}, 1000);
    } else if (job.kind === "login") { process.exit(7); }
    else if (job.kind === "setup") done(saveSetup(process.cwd(), job.setup));
    else done({ message: "Fixture operation completed" });
  }
  if (message.type === "answer") {
    send({ type: "event", event: { type: "message", text: message.response.allow ? `Query approved. No qualifying findings.${message.response.answers ? ` Answer: ${JSON.stringify(message.response.answers)}` : ""}` : "Query declined." } });
    send({ type: "event", event: { type: "phase", name: "SQL analysis", status: "completed" } });
    writeFileSync(`.rusubon/runs/${job.id}/close-out.md`, "# Friction\n\nNo qualifying findings.\n");
    done({ mcp: "ok", closeOut: `.rusubon/runs/${job.id}/close-out.md`, reports: [] });
  }
  // Deliberately ignore stop/disconnect so the real supervisor must terminate us.
});
