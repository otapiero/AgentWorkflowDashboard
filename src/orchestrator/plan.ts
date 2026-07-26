import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { planPath, taskDir } from './paths.ts';

/** The plan.md a mission carries, or null if none has been written yet. */
export function readPlan(issue: number): string | null {
  const file = planPath(issue);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/** Write the plan, creating the task directory if this mission has none yet. */
export function writePlan(issue: number, content: string): void {
  mkdirSync(taskDir(issue), { recursive: true });
  writeFileSync(planPath(issue), content, 'utf8');
}
