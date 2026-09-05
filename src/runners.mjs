import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pkgRoot } from "./config.mjs";

function which(bin) {
  const r = spawnSync("which", [bin], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

function writePrompt(prompt) {
  const file = join(tmpdir(), `rusubon-prompt-${Date.now()}.md`);
  writeFileSync(file, prompt);
  return file;
}

/** Apply the caller's deadline with a signal the runner cannot catch or ignore. */
function spawnOpts(opts, extra = {}) {
  const out = { cwd: process.cwd(), ...extra };
  if (opts.timeoutMs > 0) {
    out.timeout = opts.timeoutMs;
    out.killSignal = "SIGKILL";
  }
  return out;
}

export const RUNNERS = {
  claude: {
    which: () => which("claude"),
    warn() {
      if (process.env.ANTHROPIC_API_KEY) {
        console.warn(
          "ANTHROPIC_API_KEY is set — Claude will bill the API, not Max. unset it to use your subscription.",
        );
      }
    },
    run(prompt, opts = {}) {
      this.warn();
      writePrompt(prompt);
      const bin = process.env.RUSUBON_CLAUDE || "claude";
      const args = ["-p", prompt, "--permission-mode", "bypassPermissions", "--add-dir", pkgRoot()];
      if (opts.model) args.push("--model", opts.model);
      if (opts.effort) args.push("--effort", opts.effort);
      return spawnSync(bin, args, spawnOpts(opts, { stdio: "inherit" }));
    },
  },
  cursor: {
    which: () => which("cursor") || which("agent"),
    run(prompt, opts = {}) {
      const bin = which("agent") ? "agent" : "cursor";
      const file = writePrompt(prompt);
      return spawnSync(bin, ["-p", "--force", file], spawnOpts(opts, { stdio: "inherit", env: process.env }));
    },
  },
  codex: {
    which: () => which("codex"),
    run(prompt, opts = {}) {
      const file = writePrompt(prompt);
      return spawnSync(
        "codex",
        ["exec", "--skip-git-repo-check", "-"],
        spawnOpts(opts, {
          input: prompt + `\n\n(prompt also at ${file})\n`,
          stdio: ["pipe", "inherit", "inherit"],
        }),
      );
    },
  },
};

export function runWith(runnerName, prompt, opts = {}) {
  const runner = RUNNERS[runnerName];
  if (!runner) {
    throw new Error(`unknown runner: ${runnerName}. use claude | cursor | codex`);
  }
  const bin = runner.which();
  if (!bin) {
    throw new Error(
      `runner '${runnerName}' not on PATH. install the CLI and log in, or set another runner in rusubon.json`,
    );
  }
  const shown = runnerName === "claude" && process.env.RUSUBON_CLAUDE
    ? process.env.RUSUBON_CLAUDE
    : bin;
  const bits = [`runner: ${runnerName} (${shown})`];
  if (opts.phase) bits.push(`phase ${opts.phase}`);
  if (opts.model) bits.push(`model=${opts.model}`);
  if (opts.effort) bits.push(`effort=${opts.effort}`);
  console.log(bits.join("  "));
  const result = runner.run(prompt, opts);
  const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM";
  return { status: timedOut ? 0 : (result.status ?? 1), bin: shown, timedOut };
}
