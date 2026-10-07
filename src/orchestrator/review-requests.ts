import type { Config } from '../shared/types.ts';
import { REVIEW_REQUEST_LIMIT, type ReviewRequestsSnapshot } from '../shared/review-requests.ts';
import { fetchReviewRequests } from './github.ts';

/** Per-server cache so several tabs share one bounded GitHub read. */
export function createReviewRequestsReader(
  config: Config,
  deps: { fetch?: typeof fetchReviewRequests; now?: () => number } = {},
) {
  const fetch = deps.fetch ?? fetchReviewRequests;
  const now = deps.now ?? Date.now;
  let snapshot: ReviewRequestsSnapshot = {
    pullRequests: [], checkedAt: null, error: null, limitReached: false,
  };
  let expiresAt = 0;
  let pending: Promise<ReviewRequestsSnapshot> | null = null;

  return function read(force = false): Promise<ReviewRequestsSnapshot> {
    if (pending) return pending;
    if (!force && now() < expiresAt) return Promise.resolve(snapshot);
    pending = (async () => {
      try {
        const pullRequests = await fetch(config);
        snapshot = {
          pullRequests, checkedAt: new Date(now()).toISOString(), error: null,
          limitReached: pullRequests.length >= REVIEW_REQUEST_LIMIT,
        };
        expiresAt = now() + 60_000;
      } catch {
        snapshot = {
          ...snapshot,
          error: 'Could not load review requests. Check GitHub CLI sign-in and try again.',
        };
        expiresAt = now() + 15_000;
      }
      return snapshot;
    })();
    const current = pending;
    void current.finally(() => { if (pending === current) pending = null; });
    return current;
  };
}
