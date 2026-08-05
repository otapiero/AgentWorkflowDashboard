import type { ArtifactRef } from '../shared/types.ts';

/**
 * What a captured document is, and which copy of it is the truth.
 *
 * Artifact names are whatever the planning agent happened to write, so nothing
 * here may assume `.md` — classification is by extension plus a byte sniff, and
 * the write target is decided by which path still resolves, never by `origin`.
 */

export type ContentClass = 'markdown' | 'text' | 'binary';
export type WriteTarget = 'original' | 'snapshot';

/** Refuse to ship more than this into a textarea. */
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

/** How many leading bytes the binary sniff looks at. */
const SNIFF_BYTES = 8192;

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

/**
 * The lowercased extension of `name`, dot included, or '' when it has none.
 * A leading-dot name (`.gitignore`) is its own extension, which keeps such
 * files out of the "no extension, assume markdown" bucket.
 */
export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot).toLowerCase();
}

/** Binary beats everything; then markdown by extension or by having none. */
export function classify(name: string, bytes: Buffer): ContentClass {
  if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return 'binary';
  const ext = extensionOf(name);
  return ext === '' || MARKDOWN_EXTENSIONS.has(ext) ? 'markdown' : 'text';
}

/**
 * Which copy a read or write should address.
 *
 * `origin` is deliberately ignored: a 'taskdir' artifact's original and its
 * stored snapshot are two distinct files too, so the only question that matters
 * is whether the recorded original still exists.
 */
export function resolveWriteTarget(
  ref: ArtifactRef,
  fileExists: (path: string) => boolean,
): WriteTarget {
  return fileExists(ref.originalPath) ? 'original' : 'snapshot';
}
