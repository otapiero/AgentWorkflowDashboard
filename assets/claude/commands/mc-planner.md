---
description: Produce an Acme implementation plan for a GitHub issue.
---
Read GitHub issue #$ARGUMENTS ("{{title}}") in this repository and produce an
implementation plan for it. Plan however you normally would.

Write the plan to this exact absolute path:

    {{planPath}}

That path is deliberately outside the repository — writing it there keeps the
checkout clean. Do not create a plan file inside the repo, and do not write or
change implementation code in this phase.

{{customInstructions}}
