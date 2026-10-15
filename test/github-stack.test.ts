import { expect, test } from 'vitest';
import { createStackCollector } from '../src/orchestrator/github-stack.ts';
import { newTask } from '../src/orchestrator/state.ts';
import type { Config } from '../src/shared/types.ts';

const config = { repo: { owner: 'acme', name: 'widgets', path: 'C:\\src\\widgets', baseBranch: 'main' }, github: { copilotReviewerLogin: 'bot' } } as Config;
const node = (number: number, baseRefName = 'main') => ({ number, url: `https://github.com/acme/widgets/pull/${number}`, title: 'Change', state: 'OPEN', headRefName: `alice/${number}`, baseRefName, headRefOid: 'a'.repeat(40), headRepository: { nameWithOwner: 'acme/widgets' }, baseRepository: { nameWithOwner: 'acme/widgets' }, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } }, commits: { nodes: [] } });
const page = (nodes: unknown[], hasNextPage = false) => ({ nodes, pageInfo: { hasNextPage, endCursor: hasNextPage ? 'next' : null } });

test('deduplicates status across issues and refreshes discovery on a five-minute cadence', async () => {
  let now = 0;
  const requests: string[] = [];
  const collector = createStackCollector(config, { now: () => now, query: async query => {
    requests.push(query);
    return { data: { repository: { i0: { closedByPullRequestsReferences: page([node(10)]) }, i1: { closedByPullRequestsReferences: page([node(10)]) }, openPrs: page([node(10), node(11, 'alice/10')]), p10: node(10), p11: node(11, 'alice/10') } } };
  } });
  const tasks = [newTask(1, 'Feature', 'alice'), newTask(2, 'Other feature', 'alice')];
  const first = await collector.collect(tasks);
  expect(first.stacks.get(1)?.layers.map(p => p.number)).toEqual([10, 11]);
  expect(first.stacks.get(1)?.layers.find(p => p.number === 11)?.available).toBe(false);
  tasks.forEach(t => { t.stack = first.stacks.get(t.issue); });
  const second = await collector.collect(tasks);
  expect(requests).toHaveLength(2);
  expect(requests[0]).not.toContain('reviewThreads');
  expect(requests[1]!.match(/p10:pullRequest/g)).toHaveLength(1);
  expect(requests[1]).not.toContain('openPrs:');
  expect(requests[1]).not.toContain('closedByPullRequestsReferences');
  expect(second.stacks.get(1)?.layers.every(p => p.available)).toBe(true);
  now = 300_000;
  await collector.collect(tasks);
  expect(requests[2]).toContain('openPrs:');
});

test('a reopened discovered child resumes status polling and invalid manual lookups back off', async () => {
  let now = 0;
  const queries: string[] = [];
  const collector = createStackCollector(config, { now: () => now, query: async q => {
    queries.push(q);
    return { data: { repository: { i0: { closedByPullRequestsReferences: page([node(10)]) },
      openPrs: page([node(10), node(11, 'alice/10')]), p11: node(11, 'alice/10'), p99: null, p10: node(10) } } };
  } });
  const task = newTask(1, 'Feature', 'alice');
  const initial = await collector.collect([task]);
  task.stack = initial.stacks.get(1)!;
  task.stack.layers = task.stack.layers.map(p => ({ ...p, state: p.number === 11 ? 'CLOSED' : 'MERGED', available: true }));
  // Use a fresh collector, as after a restart, with a persisted closed child.
  const restartQueries: string[] = [];
  const restarted = createStackCollector(config, { now: () => now, query: async q => {
    restartQueries.push(q);
    return { data: { repository: { i0: { closedByPullRequestsReferences: page([{ ...node(10), state: 'MERGED' }]) },
      openPrs: page([node(11, 'alice/10')]), p11: node(11, 'alice/10'), p99: null } } };
  } });
  task.stack.manualNumbers = [99];
  task.stack = (await restarted.collect([task])).stacks.get(1)!;
  expect(task.stack.layers.find(p => p.number === 11)?.state).toBe('OPEN');
  task.stack = (await restarted.collect([task])).stacks.get(1)!;
  expect(restartQueries[1]).toContain('p11:pullRequest');
  expect(restartQueries[1]).not.toContain('p99:pullRequest');
  now = 300_000;
  await restarted.collect([task]);
  expect(restartQueries.at(-1)).toContain('p99:pullRequest');
});

test('continues index pagination on the next poll and retains membership on partial errors', async () => {
  let calls = 0;
  const collector = createStackCollector(config, { query: async () => {
    calls++;
    if (calls === 1) return { data: { repository: { i0: { closedByPullRequestsReferences: page([node(10)]) }, openPrs: page([node(10)], true) } } };
    if (calls === 2) return { data: { repository: { openPrs: page([node(11, 'alice/10')]), p10: node(10) } } };
    return { data: { repository: { p10: null, p11: node(11, 'alice/10') } }, errors: [{ path: ['repository', 'p10'] }] };
  } });
  const task = newTask(1, 'Feature', 'alice');
  const first = await collector.collect([task]);
  task.stack = first.stacks.get(1);
  expect(task.stack?.discoveryComplete).toBe(false);
  const second = await collector.collect([task]);
  task.stack = second.stacks.get(1);
  expect(calls).toBe(2);
  expect(task.stack?.layers).toHaveLength(2);
  const third = await collector.collect([task]);
  expect(third.stacks.get(1)?.layers).toHaveLength(2);
  expect(third.stacks.get(1)?.layers.find(p => p.number === 10)?.available).toBe(false);
});

test('bounds full-status work even when an issue has many PRs', async () => {
  const requests: string[] = [];
  const nodes = Array.from({ length: 31 }, (_, n) => node(n + 10));
  const collector = createStackCollector(config, { query: async q => {
    requests.push(q);
    const statuses = Object.fromEntries([...q.matchAll(/p(\d+):pullRequest/g)].map(match => [`p${match[1]}`, node(Number(match[1]))]));
    return { data: { repository: { ...statuses, i0: { closedByPullRequestsReferences: page(nodes) }, openPrs: page([]) } } };
  } });
  const task = newTask(1, 'Feature', 'alice');
  task.stack = (await collector.collect([task])).stacks.get(1)!;
  expect(requests).toHaveLength(1);
  expect(requests[0]).not.toContain('reviewThreads');
  await collector.collect([task]);
  expect(requests).toHaveLength(3);
  expect(requests.slice(1).map(q => [...q.matchAll(/p\d+:pullRequest/g)].length)).toEqual([20, 11]);
});

test('status pagination does not double-count a finished connection while another continues', async () => {
  let call = 0;
  const thread = { isResolved: false, comments: { nodes: [{ author: { login: 'alice' } }] } };
  const collector = createStackCollector(config, { query: async () => {
    call++;
    const p = { ...node(10), reviewThreads: page([thread], call === 2), commits: { nodes: [{ commit: { statusCheckRollup: { contexts: page([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }], call < 4) } } }] } };
    return { data: { repository: { i0: { closedByPullRequestsReferences: page([node(10)]) }, openPrs: page([]), p10: p } } };
  } });
  const task = newTask(1, 'Feature', 'alice');
  for (let i = 0; i < 4; i++) task.stack = (await collector.collect([task])).stacks.get(1)!;
  expect(task.stack!.layers[0]!.available).toBe(true);
  expect(task.stack!.layers[0]!.review.unresolvedThreads).toBe(2);
});
