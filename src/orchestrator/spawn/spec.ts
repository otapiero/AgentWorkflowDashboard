import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { taskDir } from '../paths.ts';
import type { Phase } from '../../shared/types.ts';

export interface SpawnSpec {
  issue: number;
  phase: Phase;
  branch: string;
  worktree: string;
  baseBranch: string;
  repoPath: string;
  /**
   * The project home the phase script writes markers into. Passed rather than
   * recomputed: the script is a separate process with no notion of an active
   * project, and a second implementation of that lookup would eventually
   * disagree with this one.
   */
  mcHome: string;
  promptFile: string;
  exe: string;
  args: string[];
  promptToken: string;
}

export function specPath(issue: number): string {
  return join(taskDir(issue), 'spawn.json');
}

export function writeSpec(spec: SpawnSpec): string {
  mkdirSync(taskDir(spec.issue), { recursive: true });
  const file = specPath(spec.issue);
  writeFileSync(file, JSON.stringify(spec, null, 2), 'utf8');
  return file;
}
