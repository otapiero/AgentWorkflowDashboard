import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { LaunchCompose } from '../src/web/components/drawer/LaunchCompose.tsx';
import { StackLayers } from '../src/web/components/drawer/StackLayers.tsx';
import { newTask } from '../src/orchestrator/state.ts';
import type { TaskWithDerived, PhaseConfig } from '../src/shared/types.ts';
import type { BoardConfig } from '../src/web/api.ts';
import type { PrLayer } from '../src/shared/pr-stack.ts';

const phase: PhaseConfig = { id: 'implement', label: 'Implement', actor: 'codex', command: 'implement', gate: { type: 'manual' } };
const config = { pipeline: [phase], agents: [{ name: 'codex' }], phaseDefaults: {} } as BoardConfig;
const layer = { host: 'github.com', repository: 'acme/widgets', number: 11, title: 'Feature', state: 'MERGED', available: false, review: { decision: 'APPROVED', unresolvedThreads: 0, copilotUnresolved: 0 } } as PrLayer;

test('Implement stays enabled with historical PRs and no explicit target', () => {
  const task = { ...newTask(1, 'Feature', 'alice'), stack: { layers: [layer], discoveryComplete: false } } as TaskWithDerived;
  const html = renderToStaticMarkup(createElement(LaunchCompose, { task, config, phase, busy: null, run: async () => {}, onBack() {} }));
  expect(html).toMatch(/<button[^>]*class="btn is-primary is-launch"[^>]*>.*Launch Implement<\/button>/);
  expect(html.match(/<button[^>]*class="btn is-primary is-launch"[^>]*>/)?.[0]).not.toContain('disabled');
  expect(html).not.toContain('Target PR #11');
});

test('PR panel offers the issue worktree as the default without detaching historical PRs', () => {
  const task = { ...newTask(1, 'Feature', 'alice'), stack: { layers: [layer], discoveryComplete: true } } as TaskWithDerived;
  const html = renderToStaticMarkup(createElement(StackLayers, { task, baseBranch: 'main', repository: 'acme/widgets', onStack() {} }));
  expect(html).toContain('Issue worktree');
  expect(html).toMatch(/<input[^>]*checked=""[^>]*\/>Issue worktree/);
  expect(html).toContain('#11');
});

test('a stale saved target can be cleared after its PR layers disappear', () => {
  const task = { ...newTask(1, 'Feature', 'alice'), stack: { layers: [], selectedKey: 'github.com/acme/widgets/11', discoveryComplete: false } } as unknown as TaskWithDerived;
  const html = renderToStaticMarkup(createElement(StackLayers, { task, baseBranch: 'main', repository: 'acme/widgets', onStack() {} }));
  expect(html).toMatch(/<input[^>]*type="radio"[^>]*\/>Issue worktree/);
});
