import { buildStack, prKey, type PrLayer, type TaskStack } from '../shared/pr-stack.ts';
import type { Config, RateLimit, TaskRecord } from '../shared/types.ts';
import { normalizeReviewDecision, parseChecksRollup, parseRateLimit, parseReviewThreads, queryGithub, type BatchedIssuePrs } from './github.ts';

const DISCOVERY_MS = 300_000;
const BATCH_SIZE = 20;
interface Page<T> { nodes: T[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } }
interface Node {
  number: number; url: string; title?: string; state: 'OPEN' | 'CLOSED' | 'MERGED';
  headRefName?: string; baseRefName?: string; headRefOid?: string;
  headRepository?: { nameWithOwner: string } | null; baseRepository?: { nameWithOwner: string } | null;
  reviewDecision?: string;
  reviewThreads?: Page<Parameters<typeof parseReviewThreads>[0] extends (infer T)[] | null | undefined ? T : never>;
  commits?: { nodes: { commit: { statusCheckRollup?: { contexts?: Page<NonNullable<Parameters<typeof parseChecksRollup>[0]>[number]> } | null } }[] };
}
interface Connection { cursor: string | null; nodes: Node[]; complete: boolean; due: number }
interface StatusPages { sha: string; threads: NonNullable<Node['reviewThreads']>['nodes']; checks: NonNullable<Parameters<typeof parseChecksRollup>[0]>; threadCursor: string | null; checkCursor: string | null }
const fresh = (): Connection => ({ cursor: null, nodes: [], complete: false, due: 0 });
const metadata = 'number url title state headRefName baseRefName headRefOid headRepository{nameWithOwner} baseRepository:repository{nameWithOwner}';
const pageInfo = 'pageInfo{hasNextPage endCursor}';
const after = (cursor: string | null) => cursor ? `,after:${JSON.stringify(cursor)}` : '';
function statusFields(p?: StatusPages): string {
  return `${metadata} reviewDecision
    reviewThreads(first:30${after(p?.threadCursor ?? null)}){${pageInfo} nodes{isResolved comments(first:1){nodes{author{login}}}}}
    commits(last:1){nodes{commit{statusCheckRollup{contexts(first:30${after(p?.checkCursor ?? null)}){${pageInfo} nodes{
      __typename ... on CheckRun{status conclusion} ... on StatusContext{state}
    }}}}}}`;
}

export interface StackCollection extends BatchedIssuePrs { stacks: Map<number, TaskStack> }

/** One collector per poller/project; all UI consumers reuse its persisted facts. */
export function createStackCollector(config: Config, deps: { now?: () => number; query?: (query: string) => Promise<unknown> } = {}) {
  const now = deps.now ?? Date.now;
  const query = deps.query ?? ((q: string) => queryGithub(config, q));
  const repo = `${config.repo.owner}/${config.repo.name}`;
  const memberships = new Map<number, Connection>();
  const fingerprints = new Map<number, string>();
  const statuses = new Map<number, PrLayer>();
  const pages = new Map<number, StatusPages>();
  let index = fresh();
  let completeIndex: Node[] = [];

  function toLayer(node: Node, source: PrLayer['source'], full: boolean): PrLayer {
    const old = statuses.get(node.number);
    const threadPage = node.reviewThreads;
    const checkPage = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
    let pending = pages.get(node.number);
    if (pending?.sha !== (node.headRefOid ?? '')) pending = undefined;
    const threads = [...(pending?.threads ?? []), ...(threadPage?.nodes ?? [])];
    const checks = [...(pending?.checks ?? []), ...(checkPage?.nodes ?? [])];
    const moreThreads = threadPage?.pageInfo?.hasNextPage ?? false;
    const moreChecks = checkPage?.pageInfo?.hasNextPage ?? false;
    if (full && (moreThreads || moreChecks)) pages.set(node.number, {
      sha: node.headRefOid ?? '', threads, checks,
      threadCursor: moreThreads ? threadPage!.pageInfo!.endCursor : null,
      checkCursor: moreChecks ? checkPage!.pageInfo!.endCursor : null,
    });
    else if (full) pages.delete(node.number);
    return {
      host: 'github.com', repository: repo, number: node.number, url: node.url,
      title: node.title ?? `PR #${node.number}`, state: node.state,
      headBranch: node.headRefName ?? old?.headBranch ?? '', baseBranch: node.baseRefName ?? old?.baseBranch ?? '',
      headRepository: node.headRepository?.nameWithOwner ?? old?.headRepository ?? repo,
      baseRepository: node.baseRepository?.nameWithOwner ?? repo, headSha: node.headRefOid ?? old?.headSha ?? '',
      checks: full ? parseChecksRollup(checks) : old?.checks ?? 'none',
      review: full ? { decision: normalizeReviewDecision(node.reviewDecision), ...parseReviewThreads(threads, config.github.copilotReviewerLogin) }
        : old?.review ?? { decision: 'NONE', unresolvedThreads: 0, copilotUnresolved: 0 },
      available: full && !moreThreads && !moreChecks,
      checkedAt: full ? new Date(now()).toISOString() : old?.checkedAt,
      source,
    };
  }
  function accept(connection: Connection, page: Page<Node>) {
    if (!connection.cursor) connection.nodes = [];
    connection.nodes.push(...page.nodes);
    connection.cursor = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
    connection.complete = !connection.cursor && !page.pageInfo?.hasNextPage;
    if (connection.complete) connection.due = now() + DISCOVERY_MS;
  }

  return {
    invalidate(issue: number) { memberships.delete(issue); fingerprints.delete(issue); index.due = 0; },
    async collect(tasks: TaskRecord[]): Promise<StackCollection> {
      const active = tasks.filter(t => t.manualPhase !== 'done');
      const stacks = new Map<number, TaskStack>();
      const unavailable = new Set<number>();
      const byIssue: BatchedIssuePrs['byIssue'] = new Map();
      const selections: { alias: string; text: string; kind: 'issue' | 'status' | 'index'; issue?: number; number?: number; bootstrap?: boolean }[] = [];
      const known = new Map<number, PrLayer>();
      for (const task of active) {
        for (const p of task.stack?.layers ?? []) { known.set(p.number, p); if (!statuses.has(p.number)) statuses.set(p.number, p); }
        const fingerprint = JSON.stringify([task.stack?.manualNumbers, task.stack?.excludedKeys]);
        if (fingerprints.get(task.issue) !== fingerprint) memberships.delete(task.issue);
        fingerprints.set(task.issue, fingerprint);
        const member = memberships.get(task.issue) ?? fresh();
        memberships.set(task.issue, member);
        if (now() >= member.due || !member.complete) {
          const bootstrap = !task.stack?.layers.length;
          selections.push({ alias: `i${active.indexOf(task)}`, issue: task.issue, kind: 'issue', bootstrap,
            text: `i${active.indexOf(task)}:issue(number:${task.issue}){closedByPullRequestsReferences(first:100,includeClosedPrs:true${after(member.cursor)}){${pageInfo} nodes{${bootstrap ? statusFields() : metadata}}}}` });
        }
        for (const number of task.stack?.manualNumbers ?? []) {
          if (!known.has(number)) known.set(number, { number, state: 'OPEN', available: false } as PrLayer);
        }
      }
      for (const [number, p] of known) {
        if (p.state !== 'OPEN' && p.available) continue;
        selections.push({ alias: `p${number}`, number, kind: 'status', text: `p${number}:pullRequest(number:${number}){${statusFields(pages.get(number))}}` });
      }
      if (active.length && (now() >= index.due || !index.complete)) selections.unshift({ alias: 'openPrs', kind: 'index',
        text: `openPrs:pullRequests(first:100,states:OPEN,orderBy:{field:CREATED_AT,direction:ASC}${after(index.cursor)}){${pageInfo} nodes{${metadata}}}` });
      let rateLimit: RateLimit | null = null;
      let failed = false;
      for (let start = 0; start < selections.length; start += BATCH_SIZE) {
        const batch = selections.slice(start, start + BATCH_SIZE);
        try {
          const raw = await query(`query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${batch.map(s => s.text).join('\n')}} rateLimit{limit remaining resetAt}}`);
          const body = raw as { data?: { repository?: Record<string, unknown> }; errors?: { path?: string[] }[] };
          const result = body.data?.repository;
          rateLimit = parseRateLimit(raw) ?? rateLimit;
          for (const selection of batch) {
            const invalid = !result || !result[selection.alias] || body.errors?.some(e => !e.path || e.path.includes(selection.alias));
            if (invalid) {
              failed = true;
              if (selection.kind === 'index') index.complete = false;
              if (selection.issue) { memberships.get(selection.issue)!.complete = false; unavailable.add(selection.issue); }
              if (selection.number && statuses.has(selection.number)) statuses.set(selection.number, { ...statuses.get(selection.number)!, available: false });
              continue;
            }
            if (selection.kind === 'index') {
              accept(index, result![selection.alias] as Page<Node>);
              if (index.complete) completeIndex = [...index.nodes];
            } else if (selection.kind === 'issue') {
              const page = (result![selection.alias] as { closedByPullRequestsReferences: Page<Node> }).closedByPullRequestsReferences;
              if (!page?.nodes) { memberships.get(selection.issue!)!.complete = false; unavailable.add(selection.issue!); continue; }
              accept(memberships.get(selection.issue!)!, page);
              for (const p of page.nodes) if (selection.bootstrap) statuses.set(p.number, toLayer(p, 'attached', true));
            } else {
              const p = result![selection.alias] as Node;
              statuses.set(p.number, toLayer(p, known.get(p.number)?.source ?? 'manual', true));
            }
          }
        } catch {
          failed = true;
          for (const selection of batch) {
            if (selection.kind === 'index') index.complete = false;
            if (selection.issue) { memberships.get(selection.issue)!.complete = false; unavailable.add(selection.issue); }
            if (selection.number && statuses.has(selection.number)) statuses.set(selection.number, { ...statuses.get(selection.number)!, available: false });
          }
        }
      }
      for (const task of active) {
        const member = memberships.get(task.issue)!;
        const members = new Map((task.stack?.layers ?? []).map(p => [p.number, statuses.get(p.number) ?? p]));
        for (const node of member.nodes) members.set(node.number, statuses.get(node.number) ?? toLayer(node, 'attached', false));
        for (const number of task.stack?.manualNumbers ?? []) {
          const p = statuses.get(number);
          if (p) members.set(number, { ...p, source: 'manual' });
        }
        // Closing references can omit non-default-base layers. Follow branch edges locally.
        let added = true;
        while (added) {
          added = false;
          for (const node of completeIndex) {
            const p = statuses.get(node.number) ?? toLayer(node, 'discovered', false);
            if (members.has(p.number) || task.stack?.excludedKeys?.includes(prKey(p))) continue;
            if ([...members.values()].some(parent => parent.headBranch && parent.headBranch === p.baseBranch && parent.headRepository.toLowerCase() === p.baseRepository.toLowerCase())) {
              members.set(p.number, p); added = true;
            }
          }
        }
        const layers = [...members.values()].filter(p => !task.stack?.excludedKeys?.includes(prKey(p)));
        const discoveryComplete = member.complete && index.complete && (task.stack?.manualNumbers ?? []).every(n => layers.some(p => p.number === n));
        const view = buildStack(layers, config.repo.baseBranch, discoveryComplete);
        const stack = { ...task.stack, layers: view.layers, discoveryComplete };
        stacks.set(task.issue, stack);
        const current = view.layers.find(p => p.state !== 'MERGED') ?? view.layers[0];
        if (current) byIssue.set(task.issue, {
          pr: { exists: true, number: current.number, url: current.url, state: view.complete ? 'MERGED' : current.state === 'MERGED' ? 'OPEN' : current.state },
          checks: current.available ? current.checks : 'pending',
          review: current.available ? current.review : { decision: 'NONE', unresolvedThreads: 0, copilotUnresolved: 0 },
        });
      }
      return { ok: !failed || stacks.size > 0, stacks, byIssue, unavailable, rateLimit };
    },
  };
}
