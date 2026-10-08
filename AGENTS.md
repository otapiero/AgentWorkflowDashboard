# Agent instructions

## Testing

A test earns its place only if all four are true:

1. **It checks real logic**: a decision, branch, transformation or side effect
   in our code, not a constant, a path join, a getter or a restatement of the
   implementation.
2. **It could catch a real bug.** Picture a plausible mistake in the source. If
   the test would stay green, it doesn't belong.
3. **It tests our code, not the framework.** Don't test zod, Fastify, React,
   Node `fs`/`path`, execa, the MCP SDK, or the test's own mocks.
4. **Nothing else already covers it.** If two tests prove the same behaviour
   through the same path, keep the stronger one.

If any answer is no, don't add the test, and delete existing tests that fail
the bar. When code is removed, remove its tests in the same change; tests for
features we no longer need are noise.

When you add a test for an invariant, break the invariant in the source once
and watch the test go red.

Two practical rules:

- Suites that start real processes (git, tsx, PowerShell) go in
  `PROCESS_SUITES` in `vite.config.ts`. That group runs after the in-process
  suites so it can't starve them of CPU. Never fix a slow or flaky test by
  raising its timeout.
- Use the neutral fixtures (`acme/widgets`, `alice`, `C:\src\widgets`). Never
  put real organisation names, issue titles, people or local work paths in
  tests or anywhere else in the repo.

Run `npm run typecheck && npm test` for the app and
`npm --prefix vscode-extension run verify` for the extension.
