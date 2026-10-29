import { execa } from 'execa';
import { SUBPROCESS_TIMEOUT_MS } from './exec.ts';

const MAX_GIT_COMMANDS = 4;
let active = 0;
const waiting: (() => void)[] = [];

/** Share a process budget between background scans and user-triggered Git work. */
export async function runGit(args: string[], cwd: string): Promise<{ stdout: string }> {
  if (active >= MAX_GIT_COMMANDS) {
    await new Promise<void>(resolve => waiting.push(resolve));
  } else {
    active++;
  }
  try {
    return await execa('git', args, { cwd, reject: true, timeout: SUBPROCESS_TIMEOUT_MS });
  } finally {
    // Transfer the occupied slot directly. Decrementing first would allow a
    // new caller to overtake the awakened caller and exceed the budget.
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
