---
name: spec
description: >-
  Produces requirements, design and verifiable tasks for actionable Rusubon
  findings. Use in the human-launched research-to-PR flow to select recommended
  options automatically and implement a validated plan without question rounds.
---

# Spec in auto mode

Adapted from `VXNCXNX/spec-skill`. Read the consuming repo's instructions and the
research verdict. Work only in the phase named by the harness prompt. Its run
id, source reference, spec directory and result path identify the current work.
Prior specs provide context, never completion evidence for this run.

## Decisions

Auto mode selects a recommendation, records why and continues. It does not call
AskUserQuestion, request_user_input or equivalent tools, present approval gates,
or pause after a fixed number of tasks.

Choose using this order: explicit user constraints, confirmed product context,
existing contracts and tests, neighboring implementations, then the smallest
reversible fix for the measured problem. Inspect available repo evidence before
guessing. Keep assumptions distinguishable from verified facts.

Record material choices in the ledger using the example below. An automatic
answer matches the recommendation and carries `decided_by: "auto"`. Preserve an
existing user choice with `decided_by: "user"` and cite that instruction.
Retain superseded decisions and their reasons; never reuse an id for a different
question. These records are decisions, not human approval receipts.

If local investigation cannot resolve missing evidence, conflicting explicit
requirements or missing authorization, write `requires_human_input` and the
specific blocker in the phase result, then exit. Auto choices never authorize
changing intentional friction, merging, deploying or production writes.

## Research phase

Read [references/example-spec.md](references/example-spec.md) before writing
files. It defines the ledger, criteria, task and verification-command formats.

1. Choose `quick`, `bug` or `feature`. Record a risk tier and reason: 1 for a
   local change, 2 for cross-component behavior, 3 for money, permissions,
   shared contracts or migrations. Scale the analysis to that risk.
2. Write `requirements.md` with the problem, evidence, expected behavior,
   numbered observable criteria, out of scope and assumptions. Bug specs include
   reproduction and root cause. For bugs and tier 3, add numbered non-regression
   criteria using `SHALL CONTINUE TO`, each with `Proven by:` naming a test file
   that exists or that a task creates. Resolve contradictions, ambiguous outcomes
   and relevant failure cases before proceeding.
3. Write `design.md` for bugs and features. Map the named files and interfaces
   to the criteria, including error handling and necessary docs or sibling changes.
   For quick specs, put the approach in requirements instead.
4. Write flat unchecked tasks. Every criterion must have a task, and every task
   must name exact repo-relative files and verification command ids. Reserve
   `enabler` for supporting work without a user-visible criterion. Include the
   regression test that would have caught the observed bug.
5. Write the ledger with the harness's run id and source reference. Leave closure
   absent. Run this check from the product checkout root and fix any failures:

   ```sh
   node <spec-resources>/scripts/check-spec.mjs <harness-spec-directory>
   ```

Research completes when that check passes and the research result is written.
Return then. The harness validates the plan before launching implementation.

## Implementation phase

Read the ledger, requirements, design if present, and tasks in full. Implement
unchecked tasks in order, changing only their declared files. Run each task's
checks and fix failures within scope before checking its box.

Requirements, design, decisions and verification commands are fixed after the
research gate. If new evidence requires a revision, return a blocker describing
that revision and preserve the files for a fresh research pass.

Implementation completes when all tasks and checks pass, all boxes are checked,
closure is `implemented`, and the implementation result includes PR text. Return
those artifacts. The harness reruns every command and alone writes the receipt
used by `--complete --receipt <path>` before publishing.
