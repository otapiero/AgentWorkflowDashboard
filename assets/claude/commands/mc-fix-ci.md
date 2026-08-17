---
description: Diagnose and fix the failing CI checks on a pull request.
---
CI is failing on the pull request for branch `{{branch}}` (issue #$ARGUMENTS).
Find out what actually failed, then fix it. Debug however you normally would.

The checks live on `{{owner}}/{{repo}}`, so start there:

    gh pr checks --repo {{owner}}/{{repo}}
    gh run view <run-id> --log-failed

{{customInstructions}}
