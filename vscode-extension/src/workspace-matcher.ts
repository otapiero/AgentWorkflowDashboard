import * as path from 'node:path';

import type { TaskWithDerived } from '../../src/shared/types.ts';

export function normalizeWorkspacePath(value: string, platform: NodeJS.Platform = process.platform): string {
  const implementation = platform === 'win32' ? path.win32 : path.posix;
  const resolved = implementation.resolve(value);
  const root = implementation.parse(resolved).root;
  const trimmed = resolved === root ? resolved : resolved.replace(/[\\/]+$/, '');
  return platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

export function matchWorkspace(
  uri: { scheme: string; fsPath: string } | undefined,
  tasks: readonly TaskWithDerived[],
  platform: NodeJS.Platform = process.platform,
): TaskWithDerived | null {
  if (!uri || uri.scheme !== 'file') return null;
  const current = normalizeWorkspacePath(uri.fsPath, platform);
  return tasks.find((task) =>
    normalizeWorkspacePath(task.integration.workspacePath, platform) === current,
  ) ?? null;
}
