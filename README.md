# Rusubon

**留守番.** The one who watches the house while you're out.

PostHog already recorded the sessions. You already pay for Claude, Cursor, or Codex.
Rusubon runs a scout on that login, through official PostHog MCP, and writes friction findings as markdown in your product repo.

A finding is a file: a path, a step that broke vs that path's baseline, enough people that it isn't one angry session. You `show` it. You `decline --why` when it's noise or a gate you meant to have. Next run can skip it. Friction never opens a PR or a GitHub issue. A human can launch `rusubon pr` after a report.

`rusubon init` in the **product** repo (not this package). Then `rusubon run friction`.
`doctor` refuses if `.rusubon/context.md` is still a placeholder, the runner isn't logged in, or PostHog MCP is missing.

Contract: [docs/inbox-contract.md](docs/inbox-contract.md).

## Install

Use macOS, Linux, or Windows through WSL. Native Windows timed subprocesses
are rejected before launch because supervision requires POSIX process groups.

```bash
git clone https://github.com/VXNCXNX/rusubon.git
cd rusubon
npm link
```

In the product repo:

```bash
rusubon init
```

That writes `rusubon.json`, `.rusubon/context.md` (you fill this), `.rusubon/memory/`, and gitignores `.rusubon/inbox/` + `.rusubon/runs/`. It does not write `.mcp.json`.

Fill `.rusubon/context.md` (product, money paths, intentional friction, out of scope) and set `posthog.projectId` in `rusubon.json`. Or propose a first pass:

```bash
rusubon context draft --about "…"
```

That writes guesses (marked as guessed) and **keeps** the placeholder. Edit the money paths. Delete the comment. `rusubon doctor` still refuses until you do. `rusubon doctor` also checks runner login and official PostHog MCP.

Log into the runner (`claude` by default). Point it at the official PostHog MCP: copy `rusubon.mcp.example.json` into Claude/Cursor MCP config, or:

```bash
npx @posthog/wizard mcp add
```

The PostHog key lives in the runner's config, never in the repo.

```bash
rusubon doctor
rusubon run friction
rusubon inbox
rusubon show <slug>
rusubon decline <slug> --why "intentional EU checkout gate"
rusubon remember pattern/capture-baseline still quiet week of …
rusubon pr <slug>
```

`run` on Claude is two passes: SQL first (capture, Vision, rage concentration), then a low-effort read of sessions that hit a money path *and* a cheap signal (rage, dead click, exception, Vision tag). Sub-agents scan those ids in parallel. The parent writes 0–3 reports. A report is a quantified title, a step vs that path's baseline, and a Series table of numbers already queried. Cap 100 sessions or 45 minutes. Cursor and Codex stop after SQL.

`run` ends with a harness block (duration, `mcp=ok|missing`, reports, memory writes, close-out) and the inbox. Read a finding with `show`. Archive it with `decline --why`.

## Layout (after init)

```
rusubon.json                       # committed: projectId + host (us|eu) + runner
.rusubon/context.md                # committed: you write this
.rusubon/memory/<prefix>/<slug>.md # committed: scout + decline why
.rusubon/inbox/reports/*.md        # gitignored: open findings
.rusubon/inbox/archive/*.md        # gitignored: declined
.rusubon/runs/*.md                 # gitignored: close-outs
.rusubon/runs/*-friction-candidates.json # gitignored: phase-two session candidates
.rusubon/runs/<run-id>/            # gitignored: PR prompts, results, logs, receipt and close-out
```

## Config

`rusubon.json`:

```json
{
  "posthog": { "projectId": "YOUR_PROJECT_ID", "host": "YOUR_REGION" },
  "runner": "claude",
  "read": { "effort": "low" }
}
```

`host` is `us` or `eu` (or `https://us.posthog.com` / `https://eu.posthog.com`). Match the region the project lives in. There is no default.

`read.effort` / `read.model` apply to the session-read pass only (Claude). Omit `read.model` to keep the CLI default model.

| `runner` | What it uses | Bills |
| --- | --- | --- |
| `claude` | Claude Code CLI / Agent SDK | Claude Pro/Max if `ANTHROPIC_API_KEY` is **unset** |
| `cursor` | Cursor CLI / `@cursor/sdk` | `CURSOR_API_KEY` |
| `codex` | Codex CLI / SDK | ChatGPT login, or API key |

Each person runs Rusubon on their machine, with their login. Do not proxy someone else's subscription.

If the runner session has no official PostHog MCP tools, the skill writes a close-out that starts with `no PostHog tools` and emits nothing.

## Skills

`friction` is the scout. After a report, a human can launch `rusubon pr`. Friction never opens a PR.

| Skill | Job |
| --- | --- |
| `friction` | Capture cliffs + money-path clusters. Findings are `requires_human_input`. Launch with `rusubon run friction`. |
| `research` | Human-launched via `rusubon pr <slug|#N|url>`. Draft PR only. Never merge. |
| `spec` | Auto-mode requirements, design and tasks between actionable research and implementation. |

`rusubon pr <slug>` runs research, then spec, implementation and verification,
then a draft PR. The bundled spec adapts [VXNCXNX/spec-skill](https://github.com/VXNCXNX/spec-skill)
for unattended execution: the agent selects recommended options from repo evidence
and records the options, choice and reason in a decision ledger. It does not
pause for spec approval or question rounds. Existing user choices take precedence.

Launch from a clean checkout root on the published branch you want the PR to
target. Its HEAD must match `origin` so unrelated local commits cannot enter the
PR. Research writes a spec in `docs/plans/YYYY-MM-DD-<source-slug>-<run-id>/`. The harness
validates it before starting a separate implementation phase on a unique branch.
Requirements, design, decisions and commands stay fixed after that gate. Only
declared files, task checkboxes and completion state may change.

The harness then executes every verification command, requiring passing TAP test
cases and valid plans, including nested subtests. Incomplete or malformed TAP
stops publishing. Zero-case plans and entirely skipped suites do not count. Test commands
must use the project's TAP reporter; ordinary lint/build checks use exit status.
Each command gets two minutes. Each runner phase gets 30 minutes. Commands run
with argv arrays and a repo-relative working directory, without shell expansion.
Node's default TAP reporter represents an empty test file as a passing test.
TAP alone cannot distinguish that wrapper from a real test with the same name;
verification does not certify that the reported cases contain assertions.

Run artifacts live in `.rusubon/runs/<run-id>/`: phase results, prompts, logs,
verification receipt and `close-out.md`. The receipt binds the exact spec and
non-ignored code contents to the checks that ran. After rechecking that evidence,
the harness commits, pushes and creates a draft PR, then opens it for review.
Submodules are recorded by their checked-out commit, or their indexed commit
when uninitialized. Uncommitted changes inside submodules stop the run.
The runner never owns publishing. These checks govern the harness workflow;
they are not a sandbox around the user's runner or proof that test assertions
capture every requirement.

Routine implementation alternatives are resolved automatically. Missing evidence,
conflicting requirements or missing authorization produce a `requires_human_input`
close-out without a PR. The scout still only writes findings; a person launches
the research-to-PR flow. Auto mode never merges or deploys. Failed runs preserve
their branch and files for review; they never reset or discard work. Before a
fresh run, commit the work you want to keep or use a clean worktree.

## What this is not

- A PostHog Cloud feature, or a fork you self-host
- A standing Replay Vision / Gemini scanner
- An Inbox UI or an auto-PR. No cron. No auto-merge. Not the PostHog wizard.
- A hosted AI reseller

## License

Apache-2.0 for Rusubon. Adapted scout text: PostHog Inc., MIT. See `NOTICE` and `LICENSE-PostHog-MIT`.
