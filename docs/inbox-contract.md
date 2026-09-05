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
.rusubon/runs/*.md                 # gitignored: scout close-outs
.rusubon/runs/<run-id>/            # gitignored: PR prompts, results, logs, receipt and close-out
```

The OSS package ships no product facts. Fill `context.md` and `rusubon.json` in *your* app.

## context.md

Human-authored. Injected at the start of every run. Advisory: it does not force an emit.

Required sections:

1. Product (≤10 lines)
2. Money paths (URLs)
3. Intentional friction — paywall, region, loading, checkout: do **not** file as bugs
4. Out of scope (staging, internal)

`rusubon context draft` can propose a first pass (repo + optional PostHog `$pageview` paths), analog of PostHog Desktop's "Build with agent". The harness **re-seals** the placeholder after the runner writes. `run` / `doctor` stay closed until a human edits money paths and intentional friction and deletes the comment. `--force` overwrites a filled file and puts the placeholder back. This is not Desktop `CONTEXT.md` (conventions, key files, reviewers).

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

A report is `.rusubon/inbox/reports/<slug>.md`. Shape: `templates/report.md`. The file is the issue. Friction never opens Linear, GitHub, or a PR. A human can launch `rusubon pr <slug>` (or an issue) to research a cause and open a draft PR. Never merge. No cron.

Required lines (plain text, not YAML):

| Field | Rule |
| --- | --- |
| `#` title | One quantified line, technical English. No poetry. |
| `priority` | `P1` / `P2` / `P3` only |
| `priority_explanation` | One sentence that cites a number |
| `actionability` | `requires_human_input` |

Body must name the path (and element if known), the step vs that path’s baseline, ≥5 persons, 2–3 recording ids.

**Series.** Paste a markdown table of numbers you already queried. Recordings vs site traffic for a capture cliff. The surface’s friction-rate series for a cluster. Pin calendar dates. The hook must stand if the table is dropped. This is the file equivalent of PostHog’s report `charts` field. We do not attach Insight nodes.

**Query.** Paste the HogQL that produced that table. A number a human cannot re-run is a number they cannot trust. File analog of Canvas “view query”. Do not invent event names. Confirm they exist (`read-data-schema`) before aggregating.

A URL with no history cannot have a step-change. First sighting of a hot new page is a `pattern/` note, not a report, unless the friction is extreme and corroborated after a session read.

A still-live report on the same surface is an edit (append the fresh window), not a second file. Write `memory/report/<slug>` after filing so the next run finds it.

| Priority | When (friction) |
| --- | --- |
| P1 | Capture cliff: ratio dropped vs its 14d norm, traffic held, no matching Team config edit. Recordings are not retroactive. |
| P2 | Corroborated money-path cluster or broken-experience cohort on a `context.md` URL, after a session read. |
| P3 | Vision watch-gap (`obs` collapsed, recordings still flow). Do not create a scanner. |

Do not file P0 or P4. If it feels P4, skip. If it feels P0, it is still a P1 cliff.

Do not file if the shape is in `context.md` intentional friction, or a `noise:` / `dedupe:` memory key already covers it.

`rusubon inbox` prints `P2  slug  title`, P1 first.

## Friction run (two phases)

`rusubon run friction` is a command you start. No cron. Leave the laptop open.

On **Claude**, the harness runs the skill twice:

1. **Phase 1 (SQL)** — capture cliff (P1), Vision watch-gap (P3), `not-in-use`. Also runs rage concentration (14d vs 24h) and the broken-experience cohort if `posthog.session_replay_features` exists. Writes `.rusubon/runs/YYYY-MM-DD-friction-candidates.json`. Does **not** file a money-path cluster.
2. **Phase 2 (read)** — only if that file has ids. Second Claude process (`read.effort` default `low`, optional `read.model` in `rusubon.json`). Parent spawns sub-agents (~10 ids each). Sub-agents return notes; they do not write the inbox. Parent clusters into 0–3 reports. Cap: 100 sessions or 45 minutes. Cursor: `.rusubon/memory/dedupe/friction-session-cursor.md`. Skip an id until a newer cheap signal.

Qualified id: money path from `context.md` in the last 7 days, plus `$rageclick` / `$dead_click` / `$exception` / `$recording_observed`, or a broken-experience row on a money path. Prefer paths whose 24h rage is ≥ ~3× the prior-13-day daily mean. Sort by signal count. Read events + console + `session_replay_features` + replay **metadata** MCP tools if present. Read stored session summaries if present. Never generate summaries. Heatmaps if present; skip if absent. No video. No new Vision scanner.

`$rageclick` fires whether or not the session was recorded. Quantify on events. Corroborate with recordings.

Zero `$recording_observed` in 30d is not `not-in-use` by itself. Failures never write that event. Check `vision-scanners-list` when the tool exists.

**Cursor / Codex:** phase 1 only. Candidates stay unread.

P2 volume gates stay: ≥5 persons / ≥10 sessions.

## Official PostHog MCP

The scout uses the official PostHog MCP (`execute-sql` / HogQL). No Composio, no Rusubon HTTP client, no `phc_` tokens in files.

If those tools are not available in the runner session, write a close-out that starts with `no PostHog tools` and emit **nothing**.

`rusubon init` never writes `.mcp.json`. See `rusubon.mcp.example.json`.

## Commands

| Command | Who | Effect |
| --- | --- | --- |
| `rusubon init` | you | scaffold + gitignore inbox/runs |
| `rusubon context draft` | you | propose `context.md` (placeholder stays) |
| `rusubon doctor` | you | preflight (context, projectId, host us\|eu, runner, MCP) |
| `rusubon run friction` | you | two-phase scout on Claude (SQL then session read); then inbox |
| `rusubon pr <slug\|#N\|url>` | you | research a report or GitHub issue; draft PR only. Never merge |
| `rusubon inbox` | you | list open reports |
| `rusubon show <slug>` | you | print a report (open or archived) |
| `rusubon remember prefix/slug …` | you or agent | upsert memory file |
| `rusubon decline <slug> --why` | you | archive + `memory/noise` |

`research` is a human-launched door (`rusubon pr`). Friction never calls it. Not the PostHog wizard. No auto-merge. No cron.

## Research-to-PR execution

`rusubon pr` requires a clean checkout root on a named base branch matching
`origin`. A unique run id owns `.rusubon/runs/<run-id>/` and
`docs/plans/<date>-<source>-<run-id>/`.
Old close-outs and results from other sources or runs cannot complete this run.

1. Research writes the auto spec and a JSON result. It does not modify product
   code. The result includes run_id, source, phase, verdict and a nonempty reason.
2. The harness validates requirements, task coverage, decisions and verification
   commands. Only an immediately_actionable result advances. The spec's run and
   source must match, with no completed tasks or closure.
   The spec directory contains only requirements.md, tasks.md, .spec-state.json,
   and design.md for bugs or features. Extra entries, including ignored files
   and nested directories, fail validation before implementation or verification.
   Each checkbox task has one nonempty Files: declaration. Stray declarations
   and duplicate Files: lines fail validation. Validation and execution share
   the same task parser. Paths may be comma-separated with whole-path backtick
   quoting, or a JSON string array. Commas inside quoted paths are preserved;
   empty entries and malformed quoting fail validation. Proven by: uses the
   same syntax for exactly one path.
   Declared files must be visible to Git and outside the harness run directory.
   Git-administrative paths are excluded, including .git entries at any depth,
   symlink aliases and relocated Git metadata directories. Normal project files
   such as .gitignore and .github workflows remain eligible.
   Ignore rules are checked before implementation and again during verification;
   already-tracked files remain eligible when an ignore rule matches them.
3. A new runner phase implements on a unique `codex/rusubon-*` branch. It may
   change declared task files, checkboxes and closure, but not the validated plan.
   Its result also supplies pr_title and pr_body, including Agent context.
4. The harness runs every command from the spec's verification array. Commands
   use executable argv and a repo-relative cwd. Test commands emit TAP with at
   least one named passing case and valid test plans at every nesting level;
   the TAP version header is optional. Nested wrappers count only their passing
   leaf cases, and skipped or TODO subtrees contribute no passing cases.
   Other checks use exit status. Invalid TAP, failures, zero-case plans,
   skipped-only suites, timeouts and code changes during verification stop the run.
5. A harness receipt binds command results and logs to the run, source, spec
   and non-ignored code contents. The harness checks it before committing,
   pushing and creating a draft PR. It opens the PR for review and never merges.
   Staging treats verified filenames literally. The staged delta may omit edits
   normalized away by Git, but cannot add paths and must include a product change.
   After hooks run, the commit must retain that exact path delta and the expected
   parent. This also rejects force-added run artifacts excluded from receipts.

The harness writes `close-out.md` for completed phases and workflow failures.
Early preflight failures do not create a run. Failed runs preserve their files
and branch. Receipt checks govern publishing through the harness; they do not
sandbox a runner with the user's credentials or prove test semantics. Ignored
dependencies and environment state are outside the code-content fingerprint.
Before research and publishing, tracked contents must match HEAD through a
temporary index without visibility flags. The check preserves the user's index,
applies Git content filters, and recurses into initialized submodules.
Count cases from TAP structure, regardless of whether their names match files.
Node's default TAP reporter emits empty-file wrappers as passing tests with no
distinctive TAP metadata. Receipts cannot establish whether such cases ran assertions.
Submodule fingerprints use the checked-out commit, or the indexed gitlink for
an uninitialized checkout. Uncommitted submodule changes, including untracked
files, stop the run because the parent PR cannot publish those contents.
