---
description: Open the pull request for the current branch using the repo's own publish-pr skill.
---
Use the `publish-pr` skill to open the pull request for branch `{{branch}}`
(GitHub issue #$ARGUMENTS).

That skill is committed in this repository and is the project's own way of
publishing: it syncs with `dev` first, generates the description from the real
commits and diff, opens the PR against `dev`, and assigns you. Follow it as
written rather than reimplementing any of it here.

If it stops because the working tree is dirty, show me what is uncommitted and
ask before committing anything.

{{customInstructions}}
