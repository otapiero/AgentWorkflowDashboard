import { expect, test } from 'vitest';
import { buildStack, layerPhase, type PrLayer } from '../src/shared/pr-stack.ts';

export const layer = (number: number, overrides: Partial<PrLayer> = {}): PrLayer => ({
  host: 'github.com', repository: 'acme/widgets', number, title: `Change ${number}`,
  url: `https://github.com/acme/widgets/pull/${number}`, state: 'OPEN',
  headRepository: 'acme/widgets', baseRepository: 'acme/widgets',
  headBranch: `alice/change-${number}`, baseBranch: 'main', headSha: 'a'.repeat(40),
  checks: 'success', review: { decision: 'APPROVED', unresolvedThreads: 0, copilotUnresolved: 0 },
  available: true, source: 'attached', ...overrides,
});

test('orders parents before children and preserves siblings and unrelated roots', () => {
  const view = buildStack([layer(12, { baseBranch: 'alice/change-10' }), layer(11, { baseBranch: 'alice/change-10' }), layer(10), layer(15)], 'main', true);
  expect(view.layers.map(p => p.number)).toEqual([10, 11, 12, 15]);
  expect(view.layers[1]!.parentKey).toContain('/10');
  expect(view.layers[1]!.warning).toContain('#10');
});

test('qualifies parents by repository and exposes cycles and ambiguous matches', () => {
  const child = layer(11, { baseBranch: 'alice/change-10' });
  expect(buildStack([layer(10, { headRepository: 'alice/widgets' }), child], 'main', true).layers.find(p => p.number === 11)?.parentKey).toBeNull();
  const cycle = buildStack([layer(10, { baseBranch: 'alice/change-11' }), child], 'main', true);
  expect(cycle.layers.every(p => p.warning?.includes('cycle'))).toBe(true);
  const ambiguous = buildStack([layer(10), layer(12, { headBranch: 'alice/change-10' }), child], 'main', true);
  expect(ambiguous.layers.find(p => p.number === 11)?.warning).toContain('Ambiguous');
});

test('requires complete discovery and every layer merged, and flags retargeting', () => {
  const parent = layer(10, { state: 'MERGED' });
  const child = layer(11, { baseBranch: parent.headBranch });
  expect(buildStack([parent, child], 'main', true).complete).toBe(false);
  expect(buildStack([parent, child], 'main', true).layers[1]!.warning).toContain('Retarget');
  expect(buildStack([parent], 'main', false).complete).toBe(false);
  expect(buildStack([parent, layer(11, { state: 'CLOSED' })], 'main', true).complete).toBe(false);
  expect(buildStack([parent], 'main', true).complete).toBe(true);
  expect(buildStack([parent, layer(11, { state: 'MERGED', available: false })], 'main', true).complete).toBe(false);
  expect(layerPhase(layer(10, { checks: 'failure' }))).toBe('ci');
});
