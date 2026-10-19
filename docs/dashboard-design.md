# Dashboard design

How `rusubon ui` looks and why. The dashboard is a house-sitter's ledger: scouts leave quantified notes, the founder stamps each one (research, or decline). Every screen serves that decision, then launching and following a run, then knowing the cost.

## Tokens

All colors are `light-dark()` pairs in `src/ui/web/app.css`. Light first.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--paper` | `#f7f8f6` | `#131614` | page and list backgrounds |
| `--surface` | `#ffffff` | `#1a1e1b` | reading pane, inputs, selected row |
| `--ink` | `#1b1f1c` | `#e7eae4` | text |
| `--muted` | `#656c66` | `#99a196` | secondary text |
| `--rule` | `#dde1da` | `#2b312c` | hairline rules, borders |
| `--rule-soft` | `#eaede7` | `#222823` | rules between rows |
| `--moss` | `#3e5a37` | `#a6c58f` | primary actions, links, connected state |
| `--vermilion` | `#b9382c` | `#e07367` | the seal, P1, failures |
| `--ochre` | `#9a6a12` | `#d8a452` | P2, waiting states |

Choosing Light or Dark in Setup's Appearance control sets `data-theme` on the root, and `light-dark()` follows the `color-scheme` that attribute pins.

No gradients. No drop shadows except the dialog. One radius for controls (5px) and one for dialogs and notices (10px). Panels are not cards: sections separate with a hairline rule and a small heading, never a box.

## Type

- Chrome: the system sans (`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui`). 14px base, 12.5px for secondary lines, 12px captions. Page title in the bar 15px/600. Section headings 13px/600 over a hairline rule.
- Reading: `Charter, "Iowan Old Style", "Source Serif Pro", Georgia, serif` for report bodies, finding titles in the reading pane, run outcome titles and the usage amount. Title 28px/400, lede 18px, body 16px/1.55, max 68ch.
- Code: `ui-monospace, "SF Mono", Menlo, Consolas` for HogQL, paths, slugs, tool names. Never for labels or numbers in prose.
- The dashboard's CSP is `default-src 'self'`, so no web fonts. Do not bundle fonts.

Never: ALL-CAPS eyebrow labels, middle-dot joined meta strings (`a · b · c`), arrow glyphs on buttons or links, a numbered marker on anything that is not a sequence.

## Layout

```
+----------+-----------------------------------------------------------+
| seal     | bar: page title   tabs / filters          actions (right) |
| repo     +---------------------------+-------------------------------+
| Inbox  6 | list pane 392px           | reading pane                  |
| Runs     | stamp  title              |  stamp  Requires human input  |
| Research |        source  date       |  Title (serif)                |
| Usage    | ------------------------- |  Lede (serif)                 |
| Setup    | stamp  title              |  facts row (hairlines)        |
|          |        source  date       |  Summary                      |
| Agents   |                           |  ...                          |
| ● Codex  |                           +-------------------------------+
| ○ Claude |                           | roles        Decline  Research |
| Local    |                           |                               |
+----------+---------------------------+-------------------------------+
```

- Sidebar 184px: vermilion seal with 留, wordmark, repository name, nav with the open finding count, and at the bottom the agent rows (dot, name, one line of state) and the local connection line. Nothing else lives in dead space.
- Every page starts with a 48px `.bar`: the page title at left, page tabs or filters next to it, page actions at the right. There is no breadcrumb header.
- Inbox is two panes. Selecting a row fills the reading pane; the list stays. Below 900px the list hides while a report is open and a Back button appears.
- Runs is two columns: the launch brief (max 720px) and recent runs (320px) beside it. Below 1100px they stack.
- Job, Research, Setup and Usage are a single column, max 880px, left aligned.
- Everything is left aligned. Reading width stays under 80 characters.

## Components (class names in `app.css`)

- `.stamp` with `.p1` `.p2` `.p3` and `.lg`: a 24px square, 1.5px border, bold 11px label. P1 is filled vermilion, P2 ochre outline, P3 grey outline. The stamp encodes priority and nothing else.
- `.dot` with `.on` `.off` `.busy` `.bad`: connection and job state. Filled moss, hollow, filled ochre, filled vermilion. No pulse, no loop.
- `.badge`: a job status as text with a dot, not a pill.
- `.btn`, `.btn.primary` (moss), `.btn.quiet` (no border), `.link` (inline text action).
- `.tabs` text tabs with a 2px underline on the active one, counts as plain small text.
- `.rows` and `.row`: a list of selectable rows with a hairline between rows, a 2px moss left bar and surface background when selected.
- `.facts`: a `dl` row of small label over value pairs between two hairlines, with an optional right-aligned link.
- `.section` with an `h2`: a hairline on top, 13px/600 heading, content below.
- `.notice` and `.notice.error`: 3px left border, paper background, 10px radius.
- `.empty`: muted sentence plus one action. Empty screens say what to do next.
- `.decide`: the pinned bar under a report with the agent roles at left and the actions at right.
- Forms: 32px controls, surface background, rule border, moss focus ring. Labels are 12.5px muted text above the control.

## Motion

One entrance per navigation (`.entering`, 220ms fade and 6px rise) and nothing that loops. `prefers-reduced-motion` turns it off. State changes that answer a click (a form opening, a row selecting) may transition for 120ms.

## Copy

Sentence case. Plain verbs. The action keeps its name through the flow: "Research & draft PR" opens a run titled "Research to draft PR". Errors say what happened and what to do. Empty states invite the next action. "Works with PostHog", never "PostHog Rusubon".
