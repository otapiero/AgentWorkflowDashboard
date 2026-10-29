# Dashboard resource usage

Implement the approved rendering, refresh, Git concurrency, and history optimizations in the existing React/Node application. Preserve the production launcher, polling intervals, notifications, persistent drafts, full-text note search, and VS Code/MCP contracts. No native/Rust migration or battery mode.

## Changes

- Own the seconds clock inside the connection indicator and the minute clock inside the attention rail. Reuse unchanged task objects and stable card props so unrelated updates do not rerender task cards.
- Consume mutation responses and server pushes instead of issuing another full reconcile after an endpoint already reconciled. Explicit manual refresh and document saves still reconcile. Settings changes reload configuration. Agent launch keeps the server's delayed marker refresh.
- Ignore observational timestamps when deciding whether a PR stack needs persistence. Persist real changes, including available/stale transitions, checks, reviews, membership, and selections.
- Limit worktree module Git subprocesses to four at once across concurrent callers. Release capacity on errors and keep existing subprocess timeouts and result semantics.
- Paginate completed tasks and active/settled notes. Keep search over the entire collection, reveal saved/reopened notes even beyond the current page, and bound note preview text rendered into the DOM. Defer history/document/editor code until opened.

## Compatibility and limits

Retain existing full note HTTP/SSE contracts and browser-side full-text search. This change bounds rendered history and lazily loads UI code, rather than adding a second note synchronization protocol. All full note data remains available for offline search and drafts.

## Verification

Use regression tests for actual duplicate requests, state-file writes, Git scheduling and error recovery, task structural sharing, list pagination/reveal/search, and clock render isolation. Prove new invariants with deliberate source mutations. Run app typecheck/tests, extension verify, production build, and Playwright. Review the complete branch before opening a PR against master.
