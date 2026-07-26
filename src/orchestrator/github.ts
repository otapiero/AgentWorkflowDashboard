import { execa } from 'execa';

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
export function parseBranchPrResponse(
  raw: unknown,
  copilotLogin: string,
): BranchPrFacts {
  const nodes = (
    raw as {
      data?: { repository?: { pullRequests?: { nodes?: BranchPrNode[] } } };
    }
  )?.data?.repository?.pullRequests?.nodes;

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
  const { stdout } = await execa('gh', args, { cwd, reject: true });
  return stdout;
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

/**
 * One GraphQL query for a branch's PR, its checks, its review decision and its
 * threads together — replacing the `gh pr list` + two `gh pr view` + graphql
 * calls this used to take. `statusCheckRollup` hangs off the PR's last commit;
 * `first:10` on the PRs covers a reopened branch while still preferring OPEN.
 */
const BRANCH_PR_QUERY = `
query($owner:String!,$name:String!,$branch:String!){
  repository(owner:$owner,name:$name){
    pullRequests(headRefName:$branch, first:10, orderBy:{field:CREATED_AT, direction:DESC}){
      nodes{
        number url state reviewDecision
        reviewThreads(first:100){
          nodes{ isResolved comments(first:1){ nodes{ author{ login } } } }
        }
        commits(last:1){
          nodes{ commit{ statusCheckRollup{ contexts(first:100){ nodes{
            __typename
            ... on CheckRun{ status conclusion }
            ... on StatusContext{ state }
          } } } } }
        }
      }
    }
  }
}`;

export async function fetchBranchPr(
  config: Config,
  branch: string,
): Promise<BranchPrFacts> {
  try {
    const out = await gh(
      [
        'api',
        'graphql',
        '-f',
        `query=${BRANCH_PR_QUERY}`,
        '-F',
        `owner=${config.repo.owner}`,
        '-F',
        `name=${config.repo.name}`,
        '-F',
        `branch=${branch}`,
      ],
      config.repo.path,
    );
    return parseBranchPrResponse(JSON.parse(out), config.github.copilotReviewerLogin);
  } catch {
    return noBranchPr();
  }
}

/**
 * The current GraphQL rate-limit budget. Querying `rateLimit` is itself free
 * (it costs zero points), so this is a cheap once-per-poll health signal.
 */
export async function fetchRateLimit(config: Config): Promise<RateLimit | null> {
  try {
    const out = await gh(
      ['api', 'graphql', '-f', 'query={ rateLimit { limit remaining resetAt } }'],
      config.repo.path,
    );
    return parseRateLimit(JSON.parse(out));
  } catch {
    return null;
  }
}
