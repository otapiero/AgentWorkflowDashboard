---
description: Produce an Acme implementation plan for a GitHub issue.
---
Read GitHub issue #$ARGUMENTS ("{{title}}") in this repository and produce a
concise, actionable implementation plan.

Write the plan to this exact absolute path:

    {{planPath}}

That path is deliberately outside the repository — writing it there keeps the
checkout clean. Do not create a plan file inside the repo.

Explore the codebase as much as you need, but do not write or change any
implementation code yet. Read the relevant AGENTS.md files for the areas the
issue touches, and make the plan follow their conventions.

The plan should cover what changes, which files, in what order, and how to
verify it. Keep it short enough to act on.

{{customInstructions}}
