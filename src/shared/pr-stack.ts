import type { ChecksState, Facts, Phase, PrState } from './types.ts';

export interface PrIdentity { host: string; repository: string; number: number }
export interface PrLayer extends PrIdentity {
  url: string; title: string; state: PrState;
  headRepository: string; baseRepository: string;
  headBranch: string; baseBranch: string; headSha: string;
  checks: ChecksState; review: Facts['review']; available: boolean;
  source: 'attached' | 'discovered' | 'manual';
  checkedAt?: string;
}
export interface TaskStack {
  layers: PrLayer[];
  selectedKey?: string | null;
  excludedKeys?: string[];
  manualNumbers?: number[];
  companionUrls?: string[];
  discoveryComplete: boolean;
}
export interface StackLayer extends PrLayer { parentKey: string | null; warning: string | null; phase: Phase }
export interface StackView { layers: StackLayer[]; complete: boolean; discoveryComplete: boolean }
export const prKey = (pr: PrIdentity): string => `${pr.host}/${pr.repository}/${pr.number}`.toLowerCase();

export function layerPhase(layer: PrLayer): Phase {
  if (layer.state === 'MERGED') return 'merged';
  if (!layer.available || layer.state === 'CLOSED') return 'publish';
  if (layer.checks === 'failure' || layer.checks === 'pending') return 'ci';
  if (layer.review.decision === 'CHANGES_REQUESTED' || layer.review.unresolvedThreads > layer.review.copilotUnresolved) return 'dev_review';
  if (layer.review.copilotUnresolved > 0) return 'copilot_review';
  if (layer.review.decision === 'APPROVED') return 'merge';
  return 'copilot_review';
}

/** Repository-qualified graph; ambiguous edges never silently pick a parent. */
export function buildStack(input: PrLayer[], baseBranch: string, discoveryComplete: boolean): StackView {
  const layers: StackLayer[] = [...new Map(input.map(p => [prKey(p), p])).values()]
    .sort((a, b) => a.number - b.number)
    .map(p => ({ ...p, parentKey: null, warning: null, phase: layerPhase(p) }));
  for (const child of layers) {
    const parents = layers.filter(p => prKey(p) !== prKey(child) && p.headBranch &&
      p.headRepository.toLowerCase() === child.baseRepository.toLowerCase() && p.headBranch === child.baseBranch);
    if (parents.length > 1) child.warning = 'Ambiguous parent branches';
    else if (parents.length === 1) {
      const parent = parents[0];
      child.parentKey = prKey(parent);
      if (child.state === 'OPEN') child.warning = parent.state === 'MERGED'
        ? `Retarget from merged #${parent.number} to ${baseBranch}`
        : `Depends on #${parent.number}`;
    }
    if (!child.available) child.warning = 'PR status unavailable';
    if (child.state === 'CLOSED') child.warning = 'Closed without merging; detach if superseded';
  }
  const byKey = new Map(layers.map(p => [prKey(p), p]));
  const ordered: StackLayer[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(p: StackLayer) {
    const key = prKey(p);
    if (visited.has(key)) return;
    if (visiting.has(key)) {
      for (const k of visiting) byKey.get(k)!.warning = 'Dependency cycle';
      return;
    }
    visiting.add(key);
    const parent = p.parentKey ? byKey.get(p.parentKey) : undefined;
    if (parent) visit(parent);
    visiting.delete(key);
    if (!visited.has(key)) { visited.add(key); ordered.push(p); }
  }
  layers.forEach(visit);
  return { layers: ordered, discoveryComplete, complete: discoveryComplete && layers.length > 0 &&
    layers.every(p => p.state === 'MERGED' && p.available && !p.warning) };
}
