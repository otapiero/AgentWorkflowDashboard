import type { TaskOverrides } from '../shared/types.ts';

/**
 * A patch over TaskOverrides: absent leaves a field alone, null clears it.
 *
 * The distinction matters because two independent surfaces write this object —
 * the Run tab owns `instructions`, the Setup tab owns agent/model/effort — and
 * a replace-everything write from either would silently delete the other's
 * work.
 */
export type OverridePatch = {
  [K in keyof TaskOverrides]?: TaskOverrides[K] | null;
};

const KEYS = ['agent', 'model', 'effort', 'instructions'] as const;

export function mergeOverrides(
  current: TaskOverrides | undefined,
  patch: OverridePatch,
): TaskOverrides | undefined {
  const next: TaskOverrides = { ...current };

  for (const key of KEYS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    // null and '' both mean "clear"; '' keeps the old `|| undefined` semantics
    // that every existing caller relies on.
    if (value) next[key] = value;
    else delete next[key];
  }

  return Object.keys(next).length > 0 ? next : undefined;
}
