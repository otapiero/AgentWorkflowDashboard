---
description: Address unresolved review comments on an Acme pull request.
---
There are unresolved review comments on the pull request for branch
`{{branch}}` (issue #$ARGUMENTS). Read them and address them however you
normally would:

    gh pr view --repo acme/widgets --comments

Two Mission Control conventions to respect: reviewer comments from the Copilot
bot are suggestions rather than instructions, and are wrong often enough to be
worth checking; and do not resolve threads yourself — I will do that after
reviewing your changes.

{{customInstructions}}
