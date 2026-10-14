import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { api } from '../api.ts';
import type { ReviewDashboardSnapshot, ReviewRequest, ReviewWorktree } from '../../shared/review-requests.ts';
import { IconPullRequest, IconSpinner, IconX } from './bits.tsx';

export function ReviewRequests({ repo, open, onOpenChange, refreshKey }: {
  repo: { owner: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  refreshKey: string;
}) {
  const [snapshot, setSnapshot] = useState<ReviewDashboardSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ number: number; kind: 'open' | 'finish' } | null>(null);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 400, maxHeight: 400 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const actionVersion = useRef(0);
  const reloadAfterPending = useRef(false);
  const mounted = useRef(false);
  const id = useId();
  const count = snapshot?.pullRequests.length;
  const failure = error ?? snapshot?.error;
  const worktrees = snapshot?.worktrees ?? [];
  const waiting = snapshot?.pullRequests.filter(pr => !worktrees.some(local => local.number === pr.number)) ?? [];
  const search = `repo:${repo.owner}/${repo.name} is:pr is:open review-requested:@me draft:false sort:updated-desc`;
  const searchUrl = `https://github.com/pulls?q=${encodeURIComponent(search)}`;

  const load: (force?: boolean) => Promise<void> = useCallback(async (force = false) => {
    if (pending.current) return;
    const version = actionVersion.current;
    pending.current = true;
    setLoading(true);
    try {
      const next = await api.reviewRequests(force);
      if (mounted.current && version === actionVersion.current) { setSnapshot(next); setError(null); }
    } catch (e) {
      if (mounted.current && version === actionVersion.current) setError(e instanceof Error ? e.message : 'Could not load review requests. Try again.');
    } finally {
      pending.current = false;
      if (mounted.current) {
        setLoading(false);
        if (reloadAfterPending.current) { reloadAfterPending.current = false; void load(); }
      }
    }
  }, []);

  async function act(number: number, kind: 'open' | 'finish') {
    if (busy) return;
    actionVersion.current += 1;
    setBusy({ number, kind });
    setActionError(null);
    setNotice(null);
    try {
      if (kind === 'open') {
        const local = await api.openReview(number);
        if (mounted.current) setSnapshot(current => current && ({
          ...current, worktrees: [local, ...current.worktrees.filter(pr => pr.number !== number)],
        }));
      } else {
        const result = await api.finishReview(number);
        if (mounted.current) {
          setSnapshot(current => current && ({ ...current, worktrees: current.worktrees.filter(pr => pr.number !== number) }));
          setNotice(result.rescued.length
            ? `Review #${number} finished. Saved local changes to ${result.rescuePath}`
            : `Review #${number} finished. Worktree removed.`);
        }
      }
    } catch (e) {
      if (mounted.current) setActionError(e instanceof Error ? e.message : 'Review action failed. Try again.');
    } finally {
      actionVersion.current += 1;
      if (mounted.current) {
        setBusy(null);
        if (pending.current) reloadAfterPending.current = true;
        else void load();
      }
    }
  }

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
      const width = Math.min(460, window.innerWidth - 24);
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

  function row(pr: ReviewRequest, local?: ReviewWorktree) {
    const isOpening = busy?.number === pr.number && busy.kind === 'open';
    const isFinishing = busy?.number === pr.number && busy.kind === 'finish';
    return (
      <li key={pr.number} className={local ? 'is-local-review' : undefined}>
        <a href={pr.url} target="_blank" rel="noreferrer">
          <IconPullRequest />
          <span className="review-item-text">
            <span className="review-item-title" dir="auto">{pr.title}</span>
            <span className="review-item-meta">#{pr.number} · {pr.author}{local
              ? <><span className="review-worktree-badge">Review</span>{!local.worktreeExists && ' · Checkout missing'}</>
              : <> · Updated <time dateTime={pr.updatedAt}>{new Date(pr.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time></>}
            </span>
          </span>
        </a>
        <div className="review-item-actions">
          <button type="button" className="btn is-sm" disabled={busy !== null}
            aria-label={`${local?.worktreeExists ? 'Open review' : 'Open for review'} PR #${pr.number} in VS Code`}
            onClick={() => void act(pr.number, 'open')}>
            {isOpening && <IconSpinner />}{isOpening ? 'Opening…' : local?.worktreeExists ? 'Open in VS Code' : 'Open for review'}
          </button>
          {local && <button type="button" className="btn is-sm is-ghost" disabled={busy !== null}
            aria-label={`Finish review PR #${pr.number}`} title="Save local changes and remove this review worktree"
            onClick={() => void act(pr.number, 'finish')}>
            {isFinishing && <IconSpinner />}{isFinishing ? 'Finishing…' : 'Finish review'}
          </button>}
        </div>
      </li>
    );
  }

  return (
    <>
      <button
        ref={trigger} type="button"
        className={`btn is-sm is-ghost review-trigger${open ? ' is-on' : ''}${failure ? ' is-stale' : ''}`}
        aria-label={`${label}${worktrees.length ? `, ${worktrees.length} local review worktrees` : ''}`} title={label} aria-haspopup="dialog" aria-expanded={open}
        aria-controls={open ? id : undefined} onClick={() => onOpenChange(!open)}
      >
        <IconPullRequest />
        <span className={`review-count${count ? ' has-reviews' : ''}`} aria-hidden>{badge}</span>
        {worktrees.length > 0 && <span className="review-local-count" aria-hidden>{worktrees.length} local</span>}
      </button>
      {open && createPortal(
        <div ref={panel} id={id} className="review-popover" role="dialog"
          aria-labelledby={`${id}-title`} style={position}>
          <header className="review-popover-head">
            <div>
              <h2 id={`${id}-title`}>Pull request reviews</h2>
              <p>{repo.owner}/{repo.name}</p>
            </div>
            <button ref={closeButton} type="button" className="btn is-sm is-icon is-ghost" aria-label="Close review requests"
              onClick={() => { onOpenChange(false); trigger.current?.focus(); }}><IconX /></button>
          </header>
          <div className="review-popover-body" aria-busy={loading}>
            {failure && <p className="review-notice" role="status">{failure}{snapshot?.checkedAt && ' Showing the last successful list.'}</p>}
            {actionError && <p className="review-notice is-error" role="alert">{actionError}</p>}
            {notice && <p className="review-notice" role="status">{notice}</p>}
            {worktrees.length > 0 && <section aria-label="Local review worktrees">
              <h3 className="review-section-title">Local review worktrees <span>{worktrees.length}</span></h3>
              <p className="review-section-hint">Finish review saves local changes and removes the checkout.</p>
              <ul className="review-list">{worktrees.map(pr => row(pr, pr))}</ul>
            </section>}
            {waiting.length > 0 && <section aria-label="Waiting for your review">
              <h3 className="review-section-title">Waiting for your review</h3>
              <ul className="review-list">{waiting.map(pr => row(pr))}</ul>
            </section>}
            {!waiting.length && !worktrees.length && !failure && (
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
