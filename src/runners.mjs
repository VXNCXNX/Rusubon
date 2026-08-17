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
    run(prompt) {
      this.warn();
      writePrompt(prompt);
      const bin = process.env.RUSUBON_CLAUDE || "claude";
      return spawnSync(
        bin,
        ["-p", prompt, "--permission-mode", "bypassPermissions", "--add-dir", pkgRoot()],
        {
          stdio: "inherit",
          cwd: process.cwd(),
        },
      );
    },
  },
  cursor: {
    which: () => which("cursor") || which("agent"),
    run(prompt) {
      const bin = which("agent") ? "agent" : "cursor";
      const file = writePrompt(prompt);
      return spawnSync(bin, ["-p", "--force", file], {
        stdio: "inherit",
        cwd: process.cwd(),
        env: process.env,
      });
    },
  },
  codex: {
    which: () => which("codex"),
    run(prompt) {
      const file = writePrompt(prompt);
      return spawnSync("codex", ["exec", "--skip-git-repo-check", "-"], {
        input: prompt + `\n\n(prompt also at ${file})\n`,
        stdio: ["pipe", "inherit", "inherit"],
        cwd: process.cwd(),
      });
    },
  },
};

export function runWith(runnerName, prompt) {
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
  console.log(`runner: ${runnerName} (${shown})`);
  const result = runner.run(prompt);
  return { status: result.status ?? 1, bin: shown };
}
