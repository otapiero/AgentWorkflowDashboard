import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { readArtifacts, resolveArtifactStoredPath } from './artifacts.ts';
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

// --- filesystem routines -------------------------------------------------

export type DocumentError = 'not-found' | 'gone' | 'too-large' | 'binary';

export type DocumentResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DocumentError };

export interface DocumentRead {
  content: string;
  class: 'markdown' | 'text';
  writeTarget: WriteTarget;
  originalPath: string;
}

/** The manifest entry plus both candidate paths, or null when unknown. */
function locate(issue: number, name: string) {
  const refs = readArtifacts(issue);
  const ref = refs.find((r) => r.name === name);
  if (!ref) return null;
  const stored = resolveArtifactStoredPath(issue, name, refs);
  if (!stored) return null;
  const target = resolveWriteTarget(ref, existsSync);
  return { ref, stored, target, active: target === 'original' ? ref.originalPath : stored };
}

/**
 * Read the copy that is the truth. Reading the snapshot unconditionally would
 * show stale text whenever the file had been edited outside the board, and the
 * next save would then overwrite that edit.
 */
export function readArtifactDocument(
  issue: number,
  name: string,
): DocumentResult<DocumentRead> {
  const found = locate(issue, name);
  if (!found) return { ok: false, error: 'not-found' };
  if (!existsSync(found.active)) return { ok: false, error: 'gone' };
  if (statSync(found.active).size > MAX_DOCUMENT_BYTES) {
    return { ok: false, error: 'too-large' };
  }

  const bytes = readFileSync(found.active);
  const contentClass = classify(name, bytes);
  if (contentClass === 'binary') return { ok: false, error: 'binary' };

  return {
    ok: true,
    value: {
      content: bytes.toString('utf8'),
      class: contentClass,
      writeTarget: found.target,
      originalPath: found.ref.originalPath,
    },
  };
}

/**
 * Write the truth, then resync the snapshot so the two never disagree. The
 * caller is told which happened so the UI can say "snapshot only" rather than
 * implying an edit reached a checkout it did not reach.
 */
export function writeArtifactDocument(
  issue: number,
  name: string,
  content: string,
): DocumentResult<WriteTarget> {
  const found = locate(issue, name);
  if (!found) return { ok: false, error: 'not-found' };

  if (found.target === 'original') {
    mkdirSync(dirname(found.ref.originalPath), { recursive: true });
    writeFileSync(found.ref.originalPath, content, 'utf8');
  }
  mkdirSync(dirname(found.stored), { recursive: true });
  writeFileSync(found.stored, content, 'utf8');

  return { ok: true, value: found.target };
}
