---
description: Open the pull request for the current branch.
---
Open the pull request for branch `{{branch}}` (GitHub issue #$ARGUMENTS)
against the `{{baseBranch}}` base branch of `{{owner}}/{{repo}}`.

If this project has its own PR-publishing skill or command available to you, use
it — it is the project's own way of publishing and probably does all of the
below. Otherwise, do these steps yourself:

1. Sync with `{{baseBranch}}` first (fetch, merge `origin/{{baseBranch}}` into
   this branch, resolve any conflicts). Do not open a PR on an unmerged branch.
2. Make sure the work is committed. If the tree is dirty, show me what is
   uncommitted and ask before committing anything.
3. Push the branch and set upstream.
4. Write the PR description from the real history —
   `git log origin/{{baseBranch}}..HEAD` and
   `git diff origin/{{baseBranch}} --stat` — as a Summary and a Changes list,
   with `Closes #$ARGUMENTS` on the first line.
5. Open the PR with `gh pr create --base {{baseBranch}} --head {{branch}}` and
   assign me (`gh pr edit <n> --add-assignee @me`). Do not add yourself as a
   reviewer.

Report the PR number and URL when done.

{{customInstructions}}
