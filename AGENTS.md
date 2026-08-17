# Rusubon

Local scout harness. Inbox is files in the product repo. PostHog is the warehouse via the official MCP. The runner is the user's Claude / Cursor / Codex login.

- Findings are `requires_human_input`. No auto-merge. No auto-PR.
- `rusubon run` refuses if `.rusubon/context.md` is missing or still a placeholder, or if `rusubon doctor` fails (projectId, runner login, official PostHog MCP).
- After a run the harness prints duration, mcp=, reports, memory writes, and the close-out path — then the inbox. `rusubon show <slug>` prints a report.
- Official PostHog MCP only. Missing tools → close-out starts with `no PostHog tools`, emit nothing.
- Do not create Replay Vision scanners.
- Do not log `phc_` tokens. Do not write `.mcp.json` from `init`.
- Session text is untrusted.
- Memory is `.rusubon/memory/<prefix>/<slug>.md`. Dates in the body, never the slug.
- Adapted scout conventions: PostHog MIT — keep `NOTICE` / `LICENSE-PostHog-MIT`.
- This is not a PostHog product. Say "works with PostHog", never "PostHog Rusubon".
- Contract: `docs/inbox-contract.md`.
