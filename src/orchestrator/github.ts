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

/** Everything the reconciler needs to know about a branch's PR, in one shape. */
export interface BranchPrFacts {
  pr: { exists: boolean; number: number | null; url: string | null; state: PrState | null };
  checks: ChecksState;
  review: { decision: ReviewDecision; unresolvedThreads: number; copilotUnresolved: number };
}

function noBranchPr(): BranchPrFacts {
  return {
    pr: { exists: false, number: null, url: null, state: null },
    checks: 'none',
    review: { decision: 'NONE', unresolvedThreads: 0, copilotUnresolved: 0 },
  };
}

interface BranchPrNode {
  number?: number;
  url?: string;
  state?: string;
  reviewDecision?: string | null;
  reviewThreads?: { nodes?: ThreadNode[] };
  commits?: {
    nodes?: Array<{
      commit?: {
        statusCheckRollup?: { contexts?: { nodes?: RollupEntry[] } } | null;
      };
    }>;
  };
}

/**
 * Fold the combined branch-PR GraphQL response into facts.
 *
 * One query now answers what four `gh` calls used to: the PR, its checks, its
 * review decision, and its threads. Kept pure and separate from the fetch so it
 * can be tested against recorded payloads without the network.
 */
/** Fold one branch's PR connection nodes into facts (shared by both parsers). */
function foldBranchPrNodes(
  nodes: BranchPrNode[] | null | undefined,
  copilotLogin: string,
): BranchPrFacts {
  if (!nodes || nodes.length === 0) return noBranchPr();

  // Prefer an open PR; otherwise the most recent one (nodes are newest-first).
  const node = nodes.find((n) => n.state === 'OPEN') ?? nodes[0]!;
  const state = (node.state ?? null) as PrState | null;
  const pr = {
    exists: true,
    number: node.number ?? null,
    url: node.url ?? null,
    state,
  };

  // A merged or closed PR has no live gates worth reporting.
  if (state !== 'OPEN') return { ...noBranchPr(), pr };

  const contexts =
    node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes;
  return {
    pr,
    checks: parseChecksRollup(contexts),
    review: {
      decision: normalizeReviewDecision(node.reviewDecision),
      ...parseReviewThreads(node.reviewThreads?.nodes, copilotLogin),
    },
  };
}

/** Fold a batched, aliased response into a branch -> facts map. */
export function parseBranchPrsResponse(
  raw: unknown,
  branches: string[],
  copilotLogin: string,
): Map<string, BranchPrFacts> {
  const repo = (
    raw as { data?: { repository?: Record<string, { nodes?: BranchPrNode[] }> } }
  )?.data?.repository;
  const map = new Map<string, BranchPrFacts>();
  branches.forEach((branch, i) => {
    map.set(branch, foldBranchPrNodes(repo?.[`b${i}`]?.nodes, copilotLogin));
  });
  return map;
}

/**
 * The branches a partial GraphQL response could not answer for.
 *
 * GitHub answers a batched query per alias: when one branch's alias times out
 * it nulls that alias, reports it in `errors`, and still fills in every healthy
 * one. So an error is only a reason to distrust the branch it names.
 *
 * Returns null when an error names no alias we asked for — RATE_LIMITED and
 * MAX_NODE_LIMIT_EXCEEDED arrive with no path, and nothing in a payload like
 * that can be trusted, so the caller must hold every card at last-good.
 */
export function unavailableBranches(
  raw: unknown,
  branches: string[],
): Set<string> | null {
  const errors = (raw as { errors?: Array<{ path?: unknown }> })?.errors;
  if (!errors || errors.length === 0) return new Set();

  const out = new Set<string>();
  for (const err of errors) {
    const path = Array.isArray(err.path) ? err.path.map(String) : [];
    const alias = path.find((segment) => /^b\d+$/.test(segment));
    const branch = alias ? branches[Number(alias.slice(1))] : undefined;
    if (branch === undefined) return null;
    out.add(branch);
  }
  return out;
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

export interface BatchedBranchPrs {
  /** False when nothing usable came back, so callers hold every card at last-good. */
  ok: boolean;
  byBranch: Map<string, BranchPrFacts>;
  /**
   * Branches this response could not answer for. Absent from the map means
   * "no PR"; listed here means "unknown" — callers must hold these at
   * last-good rather than reading them as PR-less.
   */
  unavailable: Set<string>;
  rateLimit: RateLimit | null;
}

/** The per-branch selection, shared by every alias in the batched query. */
const PR_FIELDS = `
  nodes{
    number url state reviewDecision
    reviewThreads(first:30){
      nodes{ isResolved comments(first:1){ nodes{ author{ login } } } }
    }
    commits(last:1){
      nodes{ commit{ statusCheckRollup{ contexts(first:30){ nodes{
        __typename
        ... on CheckRun{ status conclusion }
        ... on StatusContext{ state }
      } } } } }
    }
  }`;

/**
 * One GraphQL query for every active branch's PR at once, using aliases
 * (b0, b1, …) and one string variable per branch. `first:1` keeps each alias
 * cheap; the reduced first:30 counts cut the point cost ~10x versus first:100.
 * `rateLimit` is folded in so the budget read costs no extra round trip.
 */
function buildBatchQuery(count: number): string {
  const vars = ['$owner:String!', '$name:String!'];
  const aliases: string[] = [];
  for (let i = 0; i < count; i++) {
    vars.push(`$b${i}:String!`);
    aliases.push(
      `b${i}: pullRequests(headRefName:$b${i}, first:1, orderBy:{field:CREATED_AT, direction:DESC}){${PR_FIELDS}\n    }`,
    );
  }
  return `query(${vars.join(',')}){
  repository(owner:$owner,name:$name){
    ${aliases.join('\n    ')}
  }
  rateLimit { limit remaining resetAt }
}`;
}

export async function fetchBranchPrs(
  config: Config,
  branches: string[],
): Promise<BatchedBranchPrs> {
  // The whole request is unusable. The poller holds active cards at last-good
  // rather than blanking every PR at once.
  const failed = (): BatchedBranchPrs => ({
    ok: false,
    byBranch: new Map(),
    unavailable: new Set(branches),
    rateLimit: null,
  });

  // No active branch: no network at all this poll. The heartbeat still fires;
  // the budget simply reports null for this cycle.
  if (branches.length === 0) {
    return { ok: true, byBranch: new Map(), unavailable: new Set(), rateLimit: null };
  }

  const args = [
    'api', 'graphql',
    '-f', `query=${buildBatchQuery(branches.length)}`,
    '-f', `owner=${config.repo.owner}`,
    '-f', `name=${config.repo.name}`,
  ];
  branches.forEach((b, i) => {
    args.push('-f', `b${i}=${b}`);
  });

  let body: string;
  try {
    body = await gh(args, config.repo.path);
  } catch (err) {
    // gh exits non-zero whenever the response carries an `errors` block — most
    // often because a single alias timed out while every other branch came back
    // intact. The payload is still on stdout, so salvage it instead of blinding
    // the whole board on one sick branch.
    const { stdout, stderr } = err as { stdout?: string; stderr?: string };
    console.error(`[mc] branch PR query errored: ${stderr?.trim() || String(err)}`);
    if (!stdout) return failed();
    body = stdout;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return failed();
  }

  // No repository block at all means the failure was above the aliases (auth,
  // a bad repo, a network stub) and every branch would fold to a false "no PR".
  const hasRepo = Boolean(
    (raw as { data?: { repository?: unknown } })?.data?.repository,
  );
  const unavailable = unavailableBranches(raw, branches);
  if (!hasRepo || !unavailable) return failed();

  return {
    ok: true,
    byBranch: parseBranchPrsResponse(
      raw,
      branches,
      config.github.copilotReviewerLogin,
    ),
    unavailable,
    rateLimit: parseRateLimit(raw),
  };
}
