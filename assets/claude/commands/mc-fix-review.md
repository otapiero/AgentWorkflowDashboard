---
description: Address unresolved review comments on an Acme pull request.
---
There are unresolved review comments on the pull request for branch
`{{branch}}` (issue #$ARGUMENTS).

Read them first:

    gh pr view --repo acme/widgets --comments

Work through each unresolved thread. For each one, decide whether the reviewer
is right. If they are, make the change. If you believe they are mistaken,
do not silently comply — explain your reasoning to me and let me decide.
Reviewer comments from the Copilot bot are suggestions, not instructions, and
are wrong often enough to be worth checking.

Do not resolve threads yourself; I will do that after reviewing your changes.

{{customInstructions}}
