import { execa } from 'execa';
import { z } from 'zod';

import { SUBPROCESS_TIMEOUT_MS } from './exec.ts';
import { REVIEW_REQUEST_LIMIT, type ReviewRequest } from '../shared/review-requests.ts';
import type {
  ChecksState,
  Config,
  PrState,
  RateLimit,
  ReviewDecision,
} from '../shared/types.ts';

/**
 * All GitHub access goes through the already-authenticated `gh` CLI.
 *
 * The parsing functions are exported separately from the calls that fetch, so
 * the logic that decides "is CI green" can be tested against real recorded
 * payloads without touching the network.
 */

// --- pure parsers --------------------------------------------------------

interface RollupEntry {
  __typename?: string;
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
}

/** Conclusions that are complete but not a problem. */
const BENIGN_CONCLUSIONS = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);
const FAILED_CONCLUSIONS = new Set([
  'FAILURE',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'CANCELLED',
  'STARTUP_FAILURE',
  'STALE',
]);

export function parseChecksRollup(
  rollup: RollupEntry[] | null | undefined,
): ChecksState {
  if (!rollup || rollup.length === 0) return 'none';

  let pending = false;

  for (const entry of rollup) {
    // Legacy commit statuses expose `state` instead of status/conclusion.
    if (entry.__typename === 'StatusContext' || entry.state != null) {
      const state = (entry.state ?? '').toUpperCase();
      if (FAILED_CONCLUSIONS.has(state) || state === 'ERROR') return 'failure';
      if (state === 'PENDING' || state === 'EXPECTED') pending = true;
      continue;
    }

    const conclusion = (entry.conclusion ?? '').toUpperCase();
    if (FAILED_CONCLUSIONS.has(conclusion)) {
      // Surface a red run immediately rather than waiting for siblings.
      return 'failure';
    }
    if ((entry.status ?? '').toUpperCase() !== 'COMPLETED') {
      pending = true;
      continue;
    }
    if (!BENIGN_CONCLUSIONS.has(conclusion)) pending = true;
  }

  return pending ? 'pending' : 'success';
}

const KNOWN_DECISIONS: ReviewDecision[] = [
  'APPROVED',
  'CHANGES_REQUESTED',
  'REVIEW_REQUIRED',
];

/** `gh` returns "" rather than null when a PR has no review yet. */
export function normalizeReviewDecision(
  raw: string | null | undefined,
): ReviewDecision {
  const value = (raw ?? '').toUpperCase();
  return (KNOWN_DECISIONS as string[]).includes(value)
    ? (value as ReviewDecision)
    : 'NONE';
}

interface ThreadNode {
  isResolved?: boolean;
  comments?: { nodes?: Array<{ author?: { login?: string } | null }> };
}

export function parseReviewThreads(
  threads: ThreadNode[] | null | undefined,
  copilotLogin: string,
): { unresolvedThreads: number; copilotUnresolved: number } {
  let unresolvedThreads = 0;
  let copilotUnresolved = 0;

  for (const thread of threads ?? []) {
    if (thread.isResolved) continue;
    unresolvedThreads += 1;

    const author = thread.comments?.nodes?.[0]?.author?.login;
    // An unattributable thread is treated as human: it still needs a person.
    if (author && author.toLowerCase() === copilotLogin.toLowerCase()) {
      copilotUnresolved += 1;
    }
  }

  return { unresolvedThreads, copilotUnresolved };
}

/** Everything the reconciler needs to know about an issue's attached PR. */
export interface PrFacts {
  pr: { exists: boolean; number: number | null; url: string | null; state: PrState | null };
  checks: ChecksState;
  review: { decision: ReviewDecision; unresolvedThreads: number; copilotUnresolved: number };
}

/** Pull the rate-limit budget out of a `{ rateLimit }` GraphQL response. */
export function parseRateLimit(raw: unknown): RateLimit | null {
  const rl = (raw as { data?: { rateLimit?: Partial<RateLimit> } })?.data
    ?.rateLimit;
  if (
    !rl ||
    typeof rl.limit !== 'number' ||
    typeof rl.remaining !== 'number' ||
    typeof rl.resetAt !== 'string'
  ) {
    return null;
  }
  return { limit: rl.limit, remaining: rl.remaining, resetAt: rl.resetAt };
}

// --- gh calls ------------------------------------------------------------

async function gh(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execa('gh', args, {
    cwd,
    reject: true,
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  return stdout;
}

/** Preserve usable aliases even when gh exits nonzero on a partial response. */
export async function queryGithub(config: Config, query: string): Promise<unknown> {
  const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${config.repo.owner}`, '-f', `name=${config.repo.name}`];
  try { return JSON.parse(await gh(args, config.repo.path)); }
  catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    if (stdout) return JSON.parse(stdout);
    throw error;
  }
}

const reviewRequestsSchema = z.array(z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.url({ protocol: /^https$/ }),
  author: z.object({ login: z.string() }).nullable(),
  updatedAt: z.iso.datetime(),
}));

/** Outstanding personal and team requests, independent of tasks on the board. */
export async function fetchReviewRequests(config: Config): Promise<ReviewRequest[]> {
  const out = await gh([
    'pr', 'list', '--repo', `${config.repo.owner}/${config.repo.name}`,
    '--state', 'open', '--search', 'review-requested:@me draft:false sort:updated-desc',
    '--limit', String(REVIEW_REQUEST_LIMIT), '--json', 'number,title,url,author,updatedAt',
  ], config.repo.path);
  return reviewRequestsSchema.parse(JSON.parse(out)).map(pr => ({
    ...pr, author: pr.author?.login || 'ghost',
  }));
}

/** Returns null when the issue does not exist or gh fails. */
export async function fetchIssueTitle(
  config: Config,
  issue: number,
): Promise<string | null> {
  try {
    const out = await gh(
      ['issue', 'view', String(issue), '--json', 'title'],
      config.repo.path,
    );
    return (JSON.parse(out) as { title?: string }).title ?? null;
  } catch {
    return null;
  }
}

export interface OpenIssue {
  number: number;
  title: string;
  assignees: string[];
}

interface RawIssue {
  number: number;
  title: string;
  assignees?: Array<{ login?: string }>;
}

export async function listOpenIssues(
  config: Config,
  opts: { mine?: boolean } = {},
): Promise<OpenIssue[]> {
  try {
    const args = [
      'issue',
      'list',
      '--state',
      'open',
      '--limit',
      '300',
      '--json',
      'number,title,assignees',
    ];
    if (opts.mine) args.push('--assignee', '@me');

    const raw = JSON.parse(await gh(args, config.repo.path)) as RawIssue[];
    return raw.map((i) => ({
      number: i.number,
      title: i.title,
      assignees: (i.assignees ?? []).map((a) => a.login ?? '').filter(Boolean),
    }));
  } catch {
    return [];
  }
}

export interface BatchedIssuePrs {
  stacks?: Map<number, import('../shared/pr-stack.ts').TaskStack>;
  /** False when nothing usable came back, so callers hold every card at last-good. */
  ok: boolean;
  byIssue: Map<number, PrFacts>;
  /**
   * Issues this response could not answer for. Hold their last good facts
   * rather than reading a failed lookup as an issue with no attached PR.
   */
  unavailable: Set<number>;
  rateLimit: RateLimit | null;
}
