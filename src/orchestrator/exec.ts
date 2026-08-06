/**
 * The ceiling on any external command MC shells out to.
 *
 * Every reconcile runs behind the poller's single serialized promise, so one
 * command that never returns does not just lose its own result — it wedges the
 * board permanently, and no later poll can recover it. `gh` in particular can
 * hang indefinitely on a stalled TLS connection rather than failing. Bounding
 * each call is what keeps `reconcileAll` bounded, which is what keeps the
 * poller alive.
 *
 * Generous enough for a batched GraphQL query over every active branch on a
 * slow link; short enough that a wedged call costs one poll, not the session.
 */
export const SUBPROCESS_TIMEOUT_MS = 30_000;
