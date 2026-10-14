import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';

import type { Config } from '../shared/types.ts';
import type { ReviewCleanupResult, ReviewRequest, ReviewWorktree } from '../shared/review-requests.ts';
import { rescueAndRemoveWorktree } from './cleanup.ts';
import { SUBPROCESS_TIMEOUT_MS } from './exec.ts';
import { reviewDir, reviewWorktreePath, reviewsDir } from './paths.ts';
import { removeReviewWorktree } from './worktree.ts';

const recordSchema = z.object({
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  title: z.string(), url: z.url({ protocol: /^https$/ }), author: z.string(),
  updatedAt: z.iso.datetime(), openedAt: z.iso.datetime(),
  head: z.string().regex(/^[a-f0-9]{40,64}$/),
});
type ReviewRecord = z.infer<typeof recordSchema>;

function validateNumber(number: number): void {
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('Invalid PR number');
}

const recordPath = (number: number) => join(reviewDir(number), 'review.json');
const reviewRef = (number: number) => `refs/mission-control/reviews/pr-${number}`;

function readRecord(number: number): ReviewRecord | null {
  if (!existsSync(recordPath(number))) return null;
  const record = recordSchema.parse(JSON.parse(readFileSync(recordPath(number), 'utf8')));
  if (record.number !== number) throw new Error(`Review record does not match PR #${number}`);
  return record;
}

function describe(record: ReviewRecord): ReviewWorktree {
  const { head: _head, ...pr } = record;
  return { ...pr, workspacePath: reviewWorktreePath(pr.number), worktreeExists: existsSync(reviewWorktreePath(pr.number)) };
}

async function openInVscode(workspace: string): Promise<void> {
  // Keep VS Code's workspace trust protection for code being reviewed.
  await execa('code', ['--new-window', workspace], {
    detached: true, stdio: 'ignore', cleanup: false, timeout: SUBPROCESS_TIMEOUT_MS,
  });
}

/** Durable review checkouts, independent of issue tasks and the GitHub queue. */
export function createReviewWorktrees(config: Config, deps: {
  open?: (workspace: string) => Promise<void>;
  remove?: typeof removeReviewWorktree;
} = {}) {
  const openEditor = deps.open ?? openInVscode;
  const remove = deps.remove ?? removeReviewWorktree;
  const pending = new Map<number, Promise<unknown>>();
  const git = async (args: string[], cwd = config.repo.path) =>
    (await execa('git', args, { cwd, timeout: SUBPROCESS_TIMEOUT_MS })).stdout.trim();

  // Requests from multiple tabs must not create and remove the same checkout at once.
  async function serialized<T>(number: number, action: () => Promise<T>): Promise<T> {
    validateNumber(number);
    const previous = pending.get(number) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    pending.set(number, current);
    try { return await current; }
    finally { if (pending.get(number) === current) pending.delete(number); }
  }

  function list(): ReviewWorktree[] {
    if (!existsSync(reviewsDir())) return [];
    return readdirSync(reviewsDir(), { withFileTypes: true }).flatMap(entry => {
      if (!entry.isDirectory() || !/^pr-[1-9]\d*$/.test(entry.name)) return [];
      const number = Number(entry.name.slice(3));
      validateNumber(number);
      const record = readRecord(number);
      return record ? [describe(record)] : [];
    }).sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  }

  async function open(pr: ReviewRequest): Promise<ReviewWorktree> {
    return serialized(pr.number, async () => {
      const path = reviewWorktreePath(pr.number);
      let record = readRecord(pr.number);
      if (existsSync(path)) {
        if (!record) throw new Error(`Refusing to adopt an unmanaged directory at ${path}`);
        const actual = await git(['rev-parse', '--show-toplevel'], path);
        if (relative(actual, path) !== '') throw new Error('Review checkout is no longer registered. Finish review to clean it up.');
      } else {
        // GitHub's pull ref also works for PRs from forks. Each PR gets its own
        // ref, so concurrent fetches cannot race over FETCH_HEAD.
        await git(['fetch', 'origin', `+refs/pull/${pr.number}/head:${reviewRef(pr.number)}`]);
        const head = await git(['rev-parse', reviewRef(pr.number)]);
        record = recordSchema.parse({ ...pr, openedAt: record?.openedAt ?? new Date().toISOString(), head });
        mkdirSync(reviewDir(pr.number), { recursive: true });
        // Record ownership before creating the tree, so a crash leaves a review
        // the dashboard can recover or finish on its next start.
        writeFileSync(recordPath(pr.number), JSON.stringify(record, null, 2), 'utf8');
        await git(['worktree', 'prune']);
        await git(['worktree', 'add', '--detach', path, head]);
      }
      const workspace = join(reviewDir(pr.number), `Review PR ${pr.number}.code-workspace`);
      writeFileSync(workspace, JSON.stringify({
        folders: [{ path }], settings: { 'window.title': `Review PR #${pr.number} · ${config.repo.name} · ${'${activeEditorShort}'}` },
      }, null, 2), 'utf8');
      await openEditor(workspace);
      return describe(record!);
    });
  }

  async function finish(number: number): Promise<ReviewCleanupResult> {
    return serialized(number, async () => {
      const record = readRecord(number);
      if (!record) throw new Error(`No local review for PR #${number}`);
      const path = reviewWorktreePath(number);
      const rescuePath = join(reviewDir(number), 'rescued-from-worktree');
      const rescued: string[] = [];
      if (existsSync(path)) {
        // A detached checkout may contain local commits. Keep them recoverable
        // before removing its last reference. A saved bundle also survives a
        // Windows cleanup retry after git has deregistered the checkout.
        let head: string | null = null;
        try { head = await git(['rev-parse', 'HEAD'], path); }
        catch { /* Shared cleanup only permits a deregistered tree with a saved rescue receipt. */ }
        if (head) {
          if (head !== record.head) {
            mkdirSync(rescuePath, { recursive: true });
            let name = 'commits.bundle';
            for (let n = 2; existsSync(join(rescuePath, name)); n += 1) name = `commits-${n}.bundle`;
            const bundle = join(rescuePath, name);
            await git(['bundle', 'create', bundle, 'HEAD'], path);
            rescued.push(name);
          }
        } else if (existsSync(rescuePath)) {
          rescued.push(...readdirSync(rescuePath).filter(name => /^commits(?:-\d+)?\.bundle$/.test(name)));
        }
        rescued.push(...await rescueAndRemoveWorktree(path, reviewDir(number), reviewRef(number), () => remove(config, number)));
      }
      await git(['update-ref', '-d', reviewRef(number)]);
      rmSync(recordPath(number));
      rmSync(join(reviewDir(number), `Review PR ${number}.code-workspace`), { force: true });
      return { rescued, rescuePath };
    });
  }

  return { list, open, finish };
}
