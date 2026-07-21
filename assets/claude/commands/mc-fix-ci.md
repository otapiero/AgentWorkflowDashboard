---
description: Diagnose and fix the failing CI checks on an Acme pull request.
---
CI is failing on the pull request for branch `{{branch}}` (issue #$ARGUMENTS).

Find out what actually failed before changing anything:

    gh pr checks --repo acme/widgets
    gh run view <run-id> --log-failed

Read the real failure output, form a hypothesis about the cause, and fix that
cause. Do not guess at a fix, and do not disable, skip, or weaken a test to make
a check pass — if a test is genuinely wrong, say so and explain why.

Follow the AGENTS.md conventions for whichever area you end up changing.

{{customInstructions}}
