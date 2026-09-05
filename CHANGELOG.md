# Changelog

## Unreleased

Planned release: **v0.1.0, initial public preview**. No release tag or package
has been published yet.

### Included in the initial preview

- Local dashboard launched with `rusubon ui`, with setup, scout runs, findings,
  and research controls.
- Claude Code and Codex connections through the user's installed CLI and
  account, with official PostHog MCP authorization.
- Scout settings for the PostHog project, complete UTC date range, confirmed
  money paths, selected checks, and additional context. Each run saves its scope.
- Independent scout, spec creator, and implementation model and effort choices,
  checked against the connected runner. Fable 5.1 is opt-in for spec creation only.
- Live progress, agent questions and permission requests, tool activity, stop
  controls, saved artifacts, and run history.
- Findings saved as Markdown with quantified evidence. Humans can decline a
  finding or launch research, spec creation, implementation, and a verified draft
  PR in a separate worktree. No automatic merge or deployment.
- CLI scouting, context drafting, inbox review, and memory, alongside the dashboard.

### Preview limits

- macOS, Linux, and Windows through WSL. Native Windows process supervision is
  not supported.
- PostHog Cloud projects in US or EU regions, through the official MCP only.
- Claude scouts support SQL analysis and qualified session review. Codex and
  Cursor scouts stop after SQL analysis. Cursor has no dashboard connection.
- Model availability depends on the installed runner and account. Optional
  recording and replay evidence may be unavailable for a project.
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
