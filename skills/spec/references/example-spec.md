# Auto spec example

The paths and behavior below are illustrative. Replace them with evidence from
the product checkout. Read its instructions before choosing commands or scope.

The spec directory contains only `requirements.md`, `tasks.md` and
`.spec-state.json`, plus `design.md` for bugs and features. Put research notes
and evidence in the requirements; keep separate artifacts out of this directory.

`requirements.md`:

```markdown
# Retry a failed search

The issue reports that retry stays disabled after a failed search. Reproduction
and code inspection show that the error branch never clears pending state.

1.1 WHEN a search request fails THE SYSTEM SHALL allow retry.
1.2 WHEN a search request is pending THE SYSTEM SHALL CONTINUE TO disable retry.
  Proven by: `test/search.test.mjs`

## Out of scope
Changing retry limits or automatically retrying requests.

## Assumptions
Preserve the existing retry interaction, as specified by test/search.test.mjs.
```

`design.md`:

```markdown
# Design

Reset pending state in the existing cleanup path in src/search.mjs. It already
runs on success; extending it to failure covers 1.1 while preserving 1.2.
The search API and its error response stay unchanged. Add a failing-request
case to test/search.test.mjs and retain the pending-request case.
```

`tasks.md` uses flat checkboxes, without checkbox-only grouping headings:

```markdown
# Tasks

- [ ] Clear pending after failed requests and cover retry behavior.
  Files: `src/search.mjs`, `test/search.test.mjs`
  Verify: search-regression
  _Requirements: 1.1, 1.2_
```

`.spec-state.json`:

```json
{
  "mode": "auto",
  "type": "bug",
  "tier": 1,
  "risk_reason": "A local state cleanup with an existing test seam.",
  "run_id": "copy-the-harness-run-id",
  "source": "acme/app#12",
  "verification": [
    {
      "id": "search-regression",
      "kind": "test",
      "format": "tap",
      "cwd": ".",
      "argv": ["node", "--test", "--test-reporter=tap", "test/search.test.mjs"]
    }
  ],
  "decisions": [
    {
      "id": "pending-cleanup",
      "title": "Where to reset pending state",
      "options": ["existing cleanup", "new retry controller"],
      "recommended": "existing cleanup",
      "answer": "existing cleanup",
      "decided_by": "auto",
      "why": "The existing cleanup owns the state and covers both outcomes.",
      "evidence": "src/search.mjs cleanup and test/search.test.mjs pending case"
    }
  ]
}
```

Use an empty decisions array if the fix has no material choice. There are no
approval receipts. For a superseded decision, add `superseded_by` naming its
replacement id and retain the original answer and reason. For a real blocker,
leave the answer null, record `blocking` and close out without implementation.
The validator rejects unresolved decisions and blockers.

Put exactly one nonempty `Files:` line inside each checkbox task. Task blocks
end at the next checkbox or Markdown heading. List every path the task may edit;
declarations outside task blocks or repeated within a task fail validation.
Choose paths Git can publish. Ignored untracked paths and the harness run
directory cannot be task outputs; already-tracked files may match ignore rules.

`Verify:` contains comma-separated command ids, not shell text. `cwd` is relative
to the repo root. `argv` is an executable and its individual arguments, with no
shell expansion. For lint or type checks, use `kind: "check"` and omit `format`.
At least one command must be a test emitting TAP. An npm test script can use
`["npm", "test", "--", "--test-reporter=tap"]` if it forwards those flags to Node.
Choose the installed runner's TAP reporter. The harness requires named passing
test cases; zero-case plans and skipped-only suites do not count. Inspect the
tests for actual assertions: Node's default TAP reporter reports empty files as
passing tests, which the harness cannot distinguish from real named cases. If the repo
cannot emit TAP, return a blocker identifying the missing reporter. Fabricated
TAP output is not test evidence.

The harness independently reruns commands and binds their logs to the spec and
code contents. Structural validation checks these formats; it cannot prove the
test assertions cover the intended behavior or grant authorization.
