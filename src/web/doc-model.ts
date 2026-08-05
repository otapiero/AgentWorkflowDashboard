import type { ArtifactRef } from '../shared/types.ts';

/**
 * What the workbench decides without a DOM.
 *
 * This repo's test environment is node with no jsdom, so every rule worth
 * asserting — ordering, clamping, dirty tracking, mode availability — lives
 * here rather than inside the React components that consume it.
 */

export type DocId = { kind: 'plan' } | { kind: 'artifact'; name: string };
export type DocMode = 'edit' | 'split' | 'preview';

export interface DocEntry {
  id: DocId;
  /** Stable identity for maps and React keys. */
  key: string;
  label: string;
  /** True for artifacts the run wrote into the checkout. */
  inCheckout: boolean;
}

export interface DocBuffer {
  text: string;
  /** What the server last handed us; the dirty comparison baseline. */
  loaded: string;
}

/** Namespaced so an artifact literally named "plan" cannot shadow the plan. */
export function docKey(id: DocId): string {
  return id.kind === 'plan' ? 'plan' : `artifact:${id.name}`;
}

/** The plan first, then artifacts in manifest order. Names are never parsed. */
export function buildDocList(artifacts: ArtifactRef[]): DocEntry[] {
  return [
    { id: { kind: 'plan' }, key: 'plan', label: 'plan.md', inCheckout: false },
    ...artifacts.map((a): DocEntry => {
      const id: DocId = { kind: 'artifact', name: a.name };
      return { id, key: docKey(id), label: a.name, inCheckout: a.origin === 'repo' };
    }),
  ];
}

export const FONT_MIN = 11;
export const FONT_MAX = 24;
export const FONT_DEFAULT = 13;

export const SPLIT_MIN = 0.2;
export const SPLIT_MAX = 0.8;
export const SPLIT_DEFAULT = 0.5;

/** Whole pixels inside the bounds; a corrupt stored value yields the default. */
export function clampFontPx(px: number): number {
  if (!Number.isFinite(px)) return FONT_DEFAULT;
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(px)));
}

export function clampSplit(ratio: number): number {
  if (!Number.isFinite(ratio)) return SPLIT_DEFAULT;
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, ratio));
}

/**
 * Every buffer whose text has drifted from what was loaded. Closing consults
 * all of them, not just the visible document — otherwise switching away from an
 * edited file and closing would discard it silently.
 */
export function dirtyKeys(buffers: Record<string, DocBuffer>): string[] {
  return Object.entries(buffers)
    .filter(([, buffer]) => buffer.text !== buffer.loaded)
    .map(([key]) => key);
}

/** Preview only makes sense for markdown; other text is editable, not rendered. */
export function availableModes(contentClass: 'markdown' | 'text'): DocMode[] {
  return contentClass === 'markdown' ? ['edit', 'split', 'preview'] : ['edit'];
}

/** The remembered mode, degraded to one this document can actually honour. */
export function effectiveMode(preferred: DocMode, contentClass: 'markdown' | 'text'): DocMode {
  return availableModes(contentClass).includes(preferred) ? preferred : 'edit';
}
