---
description: Run a free-form instruction against a GitHub issue.
---
You are working on GitHub issue #{{issue}} ("{{title}}") on branch {{branch}}.
Read the issue with `gh issue view {{issue}}` before you start.

Write any document you produce into this exact absolute directory:

    {{taskDir}}

That path is deliberately outside the repository — writing there keeps the
checkout clean. Mission Control collects files that appear there and shows them
in the task's doc rail.

Research, specs and notes already collected for this issue:

{{artifacts}}

Read anything above that is relevant before you begin, and do not redo work it
already covers.

When you are finished, write an empty file at this exact absolute path to signal
you are done — Mission Control watches for it to collect your output:

    {{donePath}}

Your task:

{{customInstructions}}
