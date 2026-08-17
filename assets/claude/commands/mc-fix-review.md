---
description: Address unresolved review comments on a pull request.
---
There are unresolved review comments on the pull request for branch
`{{branch}}` (issue #$ARGUMENTS). Read them and address them however you
normally would:

    gh pr view --repo {{owner}}/{{repo}} --comments

Two Mission Control conventions to respect: reviewer comments from a bot
reviewer are suggestions rather than instructions, and are wrong often enough to
be worth checking; and do not resolve threads yourself — I will do that after
reviewing your changes.

{{customInstructions}}
