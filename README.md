# Rusubon

**留守番.** The one who watches the house while you're out.

PostHog already recorded the sessions. You already pay for Claude, Cursor, or Codex.
Rusubon runs a scout on that login, through official PostHog MCP, and writes friction findings as markdown in your product repo.

A finding is a file: a path, a step that broke vs that path's baseline, enough people that it isn't one angry session. You `show` it. You `decline --why` when it's noise or a gate you meant to have. Next run can skip it. Nothing opens a PR or a GitHub issue.

`rusubon init` in the **product** repo (not this package). Then `rusubon run friction`.
`doctor` refuses if `.rusubon/context.md` is still a placeholder, the runner isn't logged in, or PostHog MCP is missing.

Contract: [docs/inbox-contract.md](docs/inbox-contract.md).

## Install

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

Fill `.rusubon/context.md` (product, money paths, intentional friction, out of scope) and set `posthog.projectId` in `rusubon.json`. `rusubon doctor` checks those, plus runner login and official PostHog MCP.

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
```

`run` ends with a harness block (duration, `mcp=ok|missing`, reports, memory writes, close-out) and the inbox. Read a finding with `show`. Archive it with `decline --why`.

## Layout (after init)

```
rusubon.json                       # committed: projectId + runner
.rusubon/context.md                # committed: you write this
.rusubon/memory/<prefix>/<slug>.md # committed: scout + decline why
.rusubon/inbox/reports/*.md        # gitignored: open findings
.rusubon/inbox/archive/*.md        # gitignored: declined
.rusubon/runs/*.md                 # gitignored: close-outs
```

## Config

`rusubon.json`:

```json
{
  "posthog": { "projectId": "YOUR_PROJECT_ID", "host": "https://us.posthog.com" },
  "runner": "claude"
}
```

| `runner` | What it uses | Bills |
| --- | --- | --- |
| `claude` | Claude Code CLI / Agent SDK | Claude Pro/Max if `ANTHROPIC_API_KEY` is **unset** |
| `cursor` | Cursor CLI / `@cursor/sdk` | `CURSOR_API_KEY` |
| `codex` | Codex CLI / SDK | ChatGPT login, or API key |

Each person runs Rusubon on their machine, with their login. Do not proxy someone else's subscription.

If the runner session has no official PostHog MCP tools, the skill writes a close-out that starts with `no PostHog tools` and emits nothing.

## Skills

`friction` is the command you run. `research` stays a file on purpose: you launch it only after a report names a file.

| Skill | Job |
| --- | --- |
| `friction` | Capture cliffs + money-path clusters. Findings are `requires_human_input`. |
| `research` | Bundled file only. Manual, after a report that names a file. |

## What this is not

- A PostHog Cloud feature, or a fork you self-host
- A standing Replay Vision / Gemini scanner
- An Inbox UI or an auto-PR. No cron.
- A hosted AI reseller

## License

Apache-2.0 for Rusubon. Adapted scout text: PostHog Inc., MIT. See `NOTICE` and `LICENSE-PostHog-MIT`.
