import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { api } from '../api.ts';
import type { ReviewRequestsSnapshot } from '../../shared/review-requests.ts';
import { IconPullRequest, IconSpinner, IconX } from './bits.tsx';

export function ReviewRequests({ repo, open, onOpenChange, refreshKey }: {
  repo: { owner: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  refreshKey: string;
}) {
  const [snapshot, setSnapshot] = useState<ReviewRequestsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 400, maxHeight: 400 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  const id = useId();
  const count = snapshot?.pullRequests.length;
  const failure = error ?? snapshot?.error;
  const search = `repo:${repo.owner}/${repo.name} is:pr is:open review-requested:@me draft:false sort:updated-desc`;
  const searchUrl = `https://github.com/pulls?q=${encodeURIComponent(search)}`;

  const load = useCallback(async (force = false) => {
    if (pending.current) return;
    pending.current = true;
    setLoading(true);
    try {
      const next = await api.reviewRequests(force);
      if (mounted.current) { setSnapshot(next); setError(null); }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : 'Could not load review requests. Try again.');
    } finally {
      pending.current = false;
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const refresh = () => { if (!document.hidden) void load(); };
    const interval = setInterval(refresh, 60_000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      mounted.current = false;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [load]);

  // Opening the list and the dashboard's refresh action both request fresh data.
  const previousRefresh = useRef(refreshKey);
  useEffect(() => {
    if (previousRefresh.current !== refreshKey) {
      previousRefresh.current = refreshKey;
      void load(true);
    }
  }, [refreshKey, load]);
  useEffect(() => { if (open) void load(true); }, [open, load]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(400, window.innerWidth - 24);
      const top = rect.bottom + 8;
      setPosition({
        top, width, left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
        maxHeight: Math.max(80, Math.min(460, window.innerHeight - top - 12)),
      });
    };
    place();
    const observer = new ResizeObserver(place);
    if (trigger.current) observer.observe(trigger.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    closeButton.current?.focus();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (target: EventTarget | null) => target instanceof Node &&
      !trigger.current?.contains(target) && !panel.current?.contains(target);
    const onPointer = (e: PointerEvent) => { if (outside(e.target)) onOpenChange(false); };
    const onFocus = (e: FocusEvent) => { if (outside(e.target)) onOpenChange(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onOpenChange(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onOpenChange]);

  const badge = snapshot?.checkedAt ? `${count}${snapshot.limitReached ? '+' : ''}` : failure ? '?' : '…';
  const label = snapshot?.checkedAt
    ? `${count}${snapshot.limitReached ? '+' : ''} PRs waiting for your review${failure ? ', last known count' : ''}`
    : failure ? 'Review requests unavailable' : 'Loading review requests';

  return (
    <>
      <button
        ref={trigger} type="button"
        className={`btn is-sm is-ghost review-trigger${open ? ' is-on' : ''}${failure ? ' is-stale' : ''}`}
        aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open}
        aria-controls={open ? id : undefined} onClick={() => onOpenChange(!open)}
      >
        <IconPullRequest />
        <span className={`review-count${count ? ' has-reviews' : ''}`} aria-hidden>{badge}</span>
      </button>
      {open && createPortal(
        <div ref={panel} id={id} className="review-popover" role="dialog"
          aria-labelledby={`${id}-title`} style={position}>
          <header className="review-popover-head">
            <div>
              <h2 id={`${id}-title`}>Waiting for your review</h2>
              <p>{repo.owner}/{repo.name}</p>
            </div>
            <button ref={closeButton} type="button" className="btn is-sm is-icon is-ghost" aria-label="Close review requests"
              onClick={() => { onOpenChange(false); trigger.current?.focus(); }}><IconX /></button>
          </header>
          <div className="review-popover-body" aria-busy={loading}>
            {failure && <p className="review-notice" role="status">{failure}{snapshot?.checkedAt && ' Showing the last successful list.'}</p>}
            {snapshot?.pullRequests.length ? (
              <ul className="review-list">
                {snapshot.pullRequests.map(pr => (
                  <li key={pr.number}>
                    <a href={pr.url} target="_blank" rel="noreferrer">
                      <IconPullRequest />
                      <span className="review-item-text">
                        <span className="review-item-title" dir="auto">{pr.title}</span>
                        <span className="review-item-meta">#{pr.number} · {pr.author} · Updated <time dateTime={pr.updatedAt}>{new Date(pr.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time></span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : !failure && (
              <p className="review-empty">{snapshot?.checkedAt ? 'No PRs waiting for your review.' : 'Loading review requests…'}</p>
            )}
          </div>
          <footer className="review-popover-footer">
            <a href={searchUrl} target="_blank" rel="noreferrer">{snapshot?.limitReached ? 'See all requests on GitHub' : 'View on GitHub'}</a>
            <button type="button" className="btn is-sm is-ghost" disabled={loading} onClick={() => void load(true)}>
              {loading && <IconSpinner />} {loading ? 'Checking…' : failure ? 'Retry' : 'Refresh'}
            </button>
          </footer>
        </div>, document.body,
      )}
    </>
  );
}
