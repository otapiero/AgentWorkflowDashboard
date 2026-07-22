import { execa } from 'execa';

import type { ChecksState, Config, ReviewDecision } from '../shared/types.ts';

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

export interface PrSummary {
  number: number;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
}

export async function fetchPrForBranch(
  config: Config,
  branch: string,
): Promise<PrSummary | null> {
  try {
    const out = await gh(
      [
        'pr',
        'list',
        '--head',
        branch,
        '--state',
        'all',
        '--json',
        'number,url,state',
      ],
      config.repo.path,
    );
    const list = JSON.parse(out) as PrSummary[];
    if (list.length === 0) return null;
    // Prefer an open PR; otherwise the most recent one.
    return list.find((p) => p.state === 'OPEN') ?? list[0] ?? null;
  } catch {
    return null;
  }
}

export async function fetchChecks(
  config: Config,
  prNumber: number,
): Promise<ChecksState> {
  try {
    const out = await gh(
      ['pr', 'view', String(prNumber), '--json', 'statusCheckRollup'],
      config.repo.path,
    );
    const parsed = JSON.parse(out) as { statusCheckRollup?: RollupEntry[] };
    return parseChecksRollup(parsed.statusCheckRollup);
  } catch {
    return 'none';
  }
}

export async function fetchReviewDecision(
  config: Config,
  prNumber: number,
): Promise<ReviewDecision> {
  try {
    const out = await gh(
      ['pr', 'view', String(prNumber), '--json', 'reviewDecision'],
      config.repo.path,
    );
    return normalizeReviewDecision(
      (JSON.parse(out) as { reviewDecision?: string }).reviewDecision,
    );
  } catch {
    return 'NONE';
  }
}

const THREADS_QUERY = `
query($owner:String!,$name:String!,$pr:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$pr){
      reviewThreads(first:100){
        nodes{ isResolved comments(first:1){ nodes{ author{ login } } } }
      }
    }
  }
}`;

export async function fetchReviewThreads(
  config: Config,
  prNumber: number,
): Promise<{ unresolvedThreads: number; copilotUnresolved: number }> {
  try {
    const out = await gh(
      [
        'api',
        'graphql',
        '-f',
        `query=${THREADS_QUERY}`,
        '-F',
        `owner=${config.repo.owner}`,
        '-F',
        `name=${config.repo.name}`,
        '-F',
        `pr=${prNumber}`,
      ],
      config.repo.path,
    );
    const parsed = JSON.parse(out) as {
      data?: {
        repository?: {
          pullRequest?: { reviewThreads?: { nodes?: ThreadNode[] } };
        };
      };
    };
    return parseReviewThreads(
      parsed.data?.repository?.pullRequest?.reviewThreads?.nodes,
      config.github.copilotReviewerLogin,
    );
  } catch {
    return { unresolvedThreads: 0, copilotUnresolved: 0 };
  }
}
