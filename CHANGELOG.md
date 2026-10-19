# Changelog

## Unreleased

Planned release: **v0.1.0, initial public preview**. No release tag or package
has been published yet.

### Included in the initial preview

- Connect PostHog on Claude Code explains that Claude Code finishes MCP
  authorization in a terminal and names the command, instead of showing the
  raw CLI error.
- Repository Usage section with daily token/cost charts, model/day breakdowns,
  separate cache read/write totals, verified model rates, and local overrides.
  Estimates cover saved dashboard runs and explicitly mark missing usage.
- Local dashboard launched with `rusubon ui`, with setup, scout runs, findings,
  and research controls.
- Claude Code and Codex connections through the user's installed CLI and
  account, with official PostHog MCP authorization.
- Scout settings for the PostHog project, complete UTC date range, confirmed
  money paths, selected checks, and additional context. Each run saves its scope.
- Independent scout, spec creator, and implementation model and effort choices,
  checked against the connected runner. Fable 5.1 is opt-in for spec creation only.
- Model lineup: Claude Haiku 5.5, Sonnet 5.5 and Opus 5.5, Codex GPT-6 Luna,
  GPT-6.1 Sol and GPT-6 Astra, with Fable 5.1 still spec-only. A saved selection
  on a retired model falls back to the defaults in the dashboard until setup is
  saved again. Model rates were re-checked on October 19, 2026.
- Live progress, agent questions and permission requests, tool activity, stop
  controls, saved artifacts, and run history.
- Findings saved as Markdown with quantified evidence. Humans can decline a
  finding or launch research, spec creation, implementation, and a verified draft
  PR in a separate worktree. No automatic merge or deployment.
- CLI scouting (`friction`, `errors`), `rusubon tick` patrol, `rusubon schedule` host install, evidence checks, context drafting, inbox review, and memory, alongside the dashboard.
- PostHog inbox bridge. `rusubon inbox pull` mirrors the project's self-driving
  reports as `ph-<id>` files. `rusubon pr ph-<id>` claims the report in PostHog,
  links the draft PR and releases the claim. `rusubon decline ph-<id>` forwards
  the reason as negative feedback to the scout that filed it. Rusubon never
  authors, edits, dismisses or resolves a report in PostHog.
- Dashboard redesign. Findings became the Inbox, a two-pane page with the
  finding list beside the report and the Research or Decline decision pinned
  under it. PostHog mirrors show their status, priority and pull time as facts
  instead of raw header lines. Agent and PostHog state live in the sidebar.
  Runs, the run page, Research, Setup and Usage follow the same tokens and
  type (docs/dashboard-design.md): hairline rules instead of cards, a serif for
  reading, square priority stamps, light and dark, down to phone widths.
- Appearance control in Setup with Match the system, Light, and Dark. The
  choice applies right away and stays in this browser, never in `rusubon.json`.
- Dashboard inbox bridge. The "Pull from PostHog" button runs the same pull as
  `rusubon inbox pull`, and Decline on a `ph-` report sends the same negative
  feedback as `rusubon decline` before it archives the file. A failed send
  leaves the report open.
- Scouts read existing Replay Vision observations (`vision-observations-list`,
  `-get`, `-search`) instead of the retired session summary tools, and check
  `annotations-list` for a deploy on the day of a capture cliff. Context drafts
  may read `scout-project-profile-get`.
- Documented the PostHog AI plugin as a second MCP install path and the
  read-only MCP URL for scout-only setups.
- Dependencies: Claude Agent SDK 0.3.303, marked 18.1.1, sanitize-html 2.18.1.
  GitHub Actions runs the test suite on pull requests.

### Preview limits

- macOS, Linux, and Windows through WSL. Native Windows process supervision is
  not supported. Patrol host install writes a LaunchAgent or a user crontab. It
  does not write systemd, and it throws on native Windows.
- PostHog Cloud projects in US or EU regions, through the official MCP only.
- Claude, Codex, and Cursor scouts run SQL analysis and qualified session
  review when candidates exist. Cursor has no dashboard connection.
- `errors` scout and `rusubon check <slug>` for re-running a report's HogQL.
- Model availability depends on the installed runner and account. Optional
  recording and replay evidence may be unavailable for a project.
- The inbox bridge needs the default MCP URL; a `?readonly=true` connection
  blocks claims, PR links and feedback.
- Automated tests and browser QA cover the dashboard and scope handoff. A fresh
  package install, dashboard startup, and first Setup save have passed a smoke
  check. The new scope flow has not yet been verified with a live PostHog scout.

### Before publishing

Run a fresh-install smoke check and a live, explicitly launched scout against
a configured product project. Tag the reviewed commit as `v0.1.0`, then publish
the GitHub release as a prerelease titled **v0.1.0: Initial public preview**.
Replace this Unreleased heading with the version and publication date when it
ships. Publishing to npm is a separate step; until then, the README uses the
source-install instructions.
