---
name: friction
description: >
  Session-replay scout for money-path friction. Watches capture cliffs and
  Vision aggregates, not per-session scanner findings. Use when running
  Rusubon against a PostHog project.
---

# Scout: friction

You are a session-replay scout. Adapted from PostHog's `signals-scout-session-replay` + `signals-scout-replay-vision` (MIT).

**Discriminator: concentration-vs-diffusion on a money path.** Friction that piles up on a key URL — a step away from *that surface's* history, across ≥5 persons — is signal. Site-wide wobble, one angry user, or a Vision tag that merely tracks observation volume is baseline.

Findings are **investigations** (`requires_human_input`). Never open a PR from this skill. If a finding later has a concrete code cause, hand off to the `research` skill (manual, after this run).

Do not create Replay Vision scanners. Do not call `vision-scanners-create` or session-summary generation. Do not watch video / frames.

The harness runs this skill in **two phases** on Claude (`rusubon run friction`). Cursor/Codex get phase 1 only.

## Phase 1 — SQL

Capture + Vision roster + qualify. Write `.rusubon/runs/YYYY-MM-DD-friction-candidates.json` even if `ids` is `[]`.

You may file: P1 capture cliff, P3 Vision watch-gap, `not-in-use`. **Do not file a money-path cluster.** That is phase 2.

Qualified session: hit a **context.md money path** in the last 7d, **and** at least one cheap signal (`$rageclick`, `$dead_click`, `$exception`, `$recording_observed` tag). Sort by signal count desc. Skip an id in `dedupe/friction-session-cursor` unless `lastSignalAt` is newer than `lastRead`.

```json
{
  "windowDays": 7,
  "ids": [
    {
      "sessionId": "…",
      "signals": 12,
      "paths": ["/checkout"],
      "lastSignalAt": "2026-08-17T10:00:00Z"
    }
  ]
}
```

## Phase 2 — read (Claude parent + sub-agents)

The harness starts a second Claude process (`--effort low`, or `read.model` / `read.effort` in `rusubon.json`) and pastes the candidates.

1. Read `.rusubon/memory/dedupe/friction-session-cursor.md` if it exists. Apply the skip rule again.
2. Take at most **100** remaining ids (already worst-first). Stop at **45 minutes**.
3. Spawn **sub-agents in parallel**, ~10 ids each. Each sub-agent: HogQL events + console for those `session_id`s; `session-recording-get` / `query-session-recordings-list` if present (metadata only). Return notes: path, stuck moment, person, ids. **Sub-agents do not write inbox, candidates, cursor, or close-out.**
4. You cluster. File 0–3 reports. P2 still needs ≥5 persons / ≥10 sessions. Copy `templates/report.md`.
5. Upsert the cursor (`dedupe/friction-session-cursor`): each read id + `lastRead` (today) + `lastSignalAt`. If you hit the cap, say so in the close-out — next run continues.
6. Rewrite the close-out.

If Task/sub-agents are missing, read sequentially. Do not invent a second harness.

## Quick close-out

1. Read the **Product context** and **Memory index** in the harness prompt. If you need a key, `Read` `.rusubon/memory/<prefix>/<slug>.md`.
2. Talk to PostHog **only** through the official PostHog MCP (`execute-sql` / HogQL, or CLI-mode `exec` → `call execute-sql`).
3. If those tools are not available: write the close-out so it **starts with** `no PostHog tools` and stop. Emit nothing.
4. Otherwise run the capture + event-presence queries in [references/hogql.md](references/hogql.md). Use the project_id from the harness.

| Shape | Action |
| --- | --- |
| Zero recordings in 30d | `rusubon remember not-in-use/session-replay …` and stop |
| Zero recordings in 7d, some in 30d | Capture-cliff candidate — investigate first |
| `$rageclick` / `$dead_click` zero | Often config, not health. Use `$recording_observed` if present. |
| Recordings flowing | Full run |

## Orient

- Memory prefixes `pattern/` `noise/` `dedupe/` (index is already in the prompt)
- Capture-ratio series (14d)
- Vision roster if `$recording_observed` exists
- Money-path pageviews from **context.md**, not invented paths

Official PostHog MCP only. Never log `phc_` tokens. Never call a PostHog HTTP API from this skill.

## Profile shapes

| Pattern | Meaning |
| --- | --- |
| Capture ratio &lt; ~40% of its 14d norm, traffic held, ≥7d baseline | Cliff — check SDK / sampling / quota before filing |
| Ratio low but steady | Sampling. Not a finding. |
| Frustration mean steps up across many distinct sessions | Pull-path aggregate. Cite, don't copy, per-session Vision signals. |
| Same intent tag concentrating on one money path, persons ≥ 5 | Cluster — corroborate with 2–3 recordings |
| `$exception` on a money path with session evidence | File only the user-impact angle |
| One person, or &lt; 10 sessions / &lt; 5 persons | Storm / wobble — `noise/` |
| Vision `obs_7d` collapsed while recordings flow | Watch gap (P3). Do not create a replacement scanner. |

Volume gates: baseline &lt; ~100 recordings/day is wobble-prone — require a repeat day or an SDK story. Cluster &lt; ~10 sessions / &lt; ~5 persons → skip.

## Explore

1. **Capture cliff** — ratio vs 14d norm. A matching Team config edit = operator choice, stop.
2. **Vision pull** — frustration mean and classifier tags vs prior week. Never re-author a per-session `scanner_finding`.
3. **Money paths** — only the URLs in context.md. Do not invent a product's money paths.
4. **Exceptions** — add session framing or leave them to error-tracking.

Queries: [references/hogql.md](references/hogql.md).

## Memory

Write as you go: `Write` `.rusubon/memory/<prefix>/<slug>.md` or `rusubon remember prefix/slug …`. Prefixes: `pattern`, `noise`, `addressed`, `dedupe`, `report`, `not-in-use`. Keys on slugified paths, never raw `$el_text` / URLs. Dates in the body, never the slug. Same key = overwrite.

## Decide

Four states: net-new → write `.rusubon/inbox/reports/<slug>.md`. Material update → edit that note. Already covered / noise / listed under Intentional friction → skip.

Do not file if:

- the shape is in context.md **Intentional friction** or **Out of scope**
- a `noise/` or `dedupe/` key already covers it
- volume gates fail

A report-worthy note copies `templates/report.md`. Required: `#` title, `priority: P1|P2|P3`, `priority_explanation` (one sentence with a number), `actionability: requires_human_input`. Names the path, quantifies the step vs its baseline, passes volume gates, dates onset, links 2–3 recording ids.

| Priority | File when | Who |
| --- | --- | --- |
| P1 | Capture cliff — ratio vs 14d norm, traffic held, no matching Team config edit | Phase 1 |
| P2 | Corroborated money-path cluster on a context.md URL, persons ≥ 5, **after reading** the qualified sessions | Phase 2 only |
| P3 | Vision watch-gap (`obs_7d` collapsed, recordings still flow). Do not create a scanner. | Phase 1 |

Do not file P0 or P4. The file is the issue. Do not open Linear, GitHub, or a PR.

Then stop. Do not start `research` unless a human launches it after a note that names a file/component.

## MCP

- Official PostHog MCP only (`execute-sql` / HogQL).
- Do **not** call session-summary generation or Vision scanner create/inline-scan.
- Missing tools → close-out starts with `no PostHog tools`, emit nothing.

## Disqualifiers

- `$rageclick` absence as a health finding
- Steady low capture ratio
- Single-user storms
- Internal/localhost/staging (and anything in Out of scope)
- Intentional conversion gates listed in context.md
- Exception volume without session framing
- Re-stating a Vision push finding
- Creating or widening a Vision scanner
- Opening a PR

## Close-out

One paragraph in `.rusubon/runs/YYYY-MM-DD-friction.md`: capture posture, Vision roster, surfaces checked, notes written, what you ruled out. "Capture steady, Vision healthy, friction diffuse" is a valid outcome. If MCP was missing, the file **starts with** `no PostHog tools`.
