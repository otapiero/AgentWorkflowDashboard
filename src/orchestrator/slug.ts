const MAX_SLUG_LENGTH = 50;

/**
 * Turn a GitHub issue title into a branch-safe slug.
 *
 * Apostrophes are removed rather than treated as separators so "doesn't"
 * becomes "doesnt" instead of "doesn-t".
 */
export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (base === '') return 'task';
  if (base.length <= MAX_SLUG_LENGTH) return base;

  const clipped = base.slice(0, MAX_SLUG_LENGTH);
  // If the cap lands mid-word, fall back to the last complete word.
  const truncated =
    base.charAt(MAX_SLUG_LENGTH) === '-'
      ? clipped
      : clipped.slice(0, clipped.lastIndexOf('-'));

  const trimmed = truncated.replace(/-+$/, '');
  return trimmed === '' ? 'task' : trimmed;
}

/**
 * Compose the task branch as `<prefix>/<issue>-<slug>`.
 *
 * This shape matters beyond aesthetics: the repo's own /publish-pr skill
 * recovers the issue number by taking the numeric portion after the first "/".
 */
export function branchName(
  prefix: string,
  issue: number,
  title: string,
): string {
  return `${prefix}/${issue}-${slugify(title)}`;
}
