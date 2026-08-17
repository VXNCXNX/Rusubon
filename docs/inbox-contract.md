# Inbox contract (files)

Rusubon copies PostHog Inbox as a file tree in the **product** repo. No UI. Trigger is a command you run. Official PostHog MCP only — Rusubon never calls the PostHog HTTP API.

## Layout

Created by `rusubon init` in the product repo:

```
rusubon.json                       # committed — projectId + host (us|eu) + runner
.rusubon/context.md                # committed — you write this
.rusubon/memory/<prefix>/<slug>.md # committed — scout + decline why
.rusubon/inbox/reports/*.md        # gitignored — open findings
.rusubon/inbox/archive/*.md        # gitignored — declined
.rusubon/runs/*.md                 # gitignored — close-outs
```

The OSS package ships no product facts. Fill `context.md` and `rusubon.json` in *your* app.

## context.md

Human-authored. Injected at the start of every run. Advisory: it does not force an emit.

Required sections:

1. Product (≤10 lines)
2. Money paths (URLs)
3. Intentional friction — paywall, region, loading, checkout: do **not** file as bugs
4. Out of scope (staging, internal)

`rusubon run` refuses while the placeholder marker `RUSUBON_CONTEXT_PLACEHOLDER` is still in the file, or if `rusubon doctor` fails (projectId or host still a placeholder, host not `us`/`eu`, runner missing / not logged in, no official PostHog MCP on the runner). No HTTP call to PostHog — doctor only inspects local files and the runner CLI.

## Memory

Key/value prose. One file per key. Same key = overwrite. Dates go in the **body**, never the slug.

Prefixes: `pattern`, `noise`, `addressed`, `dedupe`, `not-in-use`, `report`.

Slug: `[a-z0-9][a-z0-9-]*`. No `..`, no extra path segments. A `YYYY-MM-DD` in the slug is rejected.

A good entry is future-run actionable: “if still X → escalate; if quiet → skip.”

Read path (not Claude hooks):

1. Harness injects an **index** (key + first line) into the opening prompt.
2. Later tool turns `Read` `.rusubon/memory/<prefix>/<slug>.md`.
3. Writes: `Write` that file, or `rusubon remember prefix/slug …`.

`rusubon decline <slug> --why "…"` moves the report to archive and upserts `memory/noise/<slug>.md`. Resolving later does **not** write a why.

If the index exceeds ~80 keys, friction only sees `pattern`, `noise`, and `dedupe`.

## Reports

A report is `.rusubon/inbox/reports/<slug>.md`. Shape: `templates/report.md`. The file is the issue. Nothing opens Linear or GitHub.

Required lines (plain text, not YAML):

| Field | Rule |
| --- | --- |
| `#` title | One quantified line |
| `priority` | `P1` / `P2` / `P3` only |
| `priority_explanation` | One sentence that cites a number |
| `actionability` | `requires_human_input` |

Body must name the path, the step vs that path’s baseline, ≥5 persons, 2–3 recording ids.

| Priority | When (friction) |
| --- | --- |
| P1 | Capture cliff: ratio dropped vs its 14d norm, traffic held, no matching Team config edit. Recordings are not retroactive. |
| P2 | Corroborated money-path cluster on a `context.md` URL. |
| P3 | Vision watch-gap (`obs` collapsed, recordings still flow). Do not create a scanner. |

Do not file P0 or P4. If it feels P4, skip. If it feels P0, it is still a P1 cliff.

Do not file if the shape is in `context.md` intentional friction, or a `noise:` / `dedupe:` memory key already covers it.

`rusubon inbox` prints `P2  slug  title`, P1 first.

## Official PostHog MCP

The scout uses the official PostHog MCP (`execute-sql` / HogQL). No Composio, no Rusubon HTTP client, no `phc_` tokens in files.

If those tools are not available in the runner session, write a close-out that starts with `no PostHog tools` and emit **nothing**.

`rusubon init` never writes `.mcp.json`. See `rusubon.mcp.example.json`.

## Commands

| Command | Who | Effect |
| --- | --- | --- |
| `rusubon init` | you | scaffold + gitignore inbox/runs |
| `rusubon doctor` | you | preflight (context, projectId, host us\|eu, runner, MCP) |
| `rusubon run friction` | you | manual scout; harness prints the summary, then inbox |
| `rusubon inbox` | you | list open reports |
| `rusubon show <slug>` | you | print a report (open or archived) |
| `rusubon remember prefix/slug …` | you or agent | upsert memory file |
| `rusubon decline <slug> --why` | you | archive + `memory/noise` |

`research` is a bundled skill file only. Do not treat it as v0.
