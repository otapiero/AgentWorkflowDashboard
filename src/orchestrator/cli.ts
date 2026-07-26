/**
 * Headless harness for the orchestrator.
 *
 * Exists so every layer below the UI can be exercised and verified before a
 * server or a browser is involved:
 *
 *   npm run mc -- doctor
 *   npm run mc -- import 3060
 *   npm run mc -- facts 3060
 *   npm run mc -- reconcile 3060
 *   npm run mc -- list
 *   npm run mc -- spawn 3060 plan
 */
import { execa } from 'execa';

import { loadConfig } from './config.ts';
import { gatherFacts } from './facts.ts';
import { reconcile } from './reconcile.ts';
import { getTask, listTasks, newTask, removeTask, upsertTask } from './state.ts';
import { fetchBranchPrs, fetchIssueTitle, listOpenIssues } from './github.ts';
import { spawnPhase } from './spawn.ts';
import { listBranches, resolveBranch } from './worktree.ts';
import { mcHome } from './paths.ts';
import type { Config, TaskRecord } from '../shared/types.ts';

function die(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function requireTask(issue: number): TaskRecord {
  const task = getTask(issue);
  if (!task) die(`issue ${issue} is not on the board (run: mc import ${issue})`);
  return task;
}

async function doctor(config: Config): Promise<void> {
  console.log(`home        ${mcHome()}`);
  console.log(`repo        ${config.repo.path}`);
  console.log(`github      ${config.repo.owner}/${config.repo.name} (base ${config.repo.baseBranch})`);
  console.log(`branches    ${config.repo.branchPrefix}/<issue>-<slug>`);
  console.log(`agents      ${Object.keys(config.agents).join(', ')}`);
  console.log(`pipeline    ${config.pipeline.map((p) => p.id).join(' -> ')}`);
  console.log('');

  for (const tool of ['git', 'gh', 'wt', 'pwsh', ...Object.values(config.agents).map((a) => a.launch)]) {
    try {
      await execa(tool, ['--version'], { timeout: 15000 });
      console.log(`  ok      ${tool}`);
    } catch {
      console.log(`  MISSING ${tool}`);
    }
  }

  try {
    await execa('gh', ['auth', 'status'], { cwd: config.repo.path });
    console.log('  ok      gh authenticated');
  } catch {
    console.log('  MISSING gh not authenticated');
  }
}

async function importIssue(config: Config, issue: number): Promise<void> {
  const title = await fetchIssueTitle(config, issue);
  if (!title) die(`could not read issue ${issue} from ${config.repo.owner}/${config.repo.name}`);
  const task = newTask(issue, title, config.repo.branchPrefix);
  // An existing branch for this issue wins over the generated slug.
  const branch = await resolveBranch(config, issue, task.branch);
  upsertTask({ ...task, branch });
  console.log(`imported #${issue}  ${title}`);
  console.log(`branch   ${branch}${branch === task.branch ? '' : '  (adopted existing)'}`);
}

function printDerived(task: TaskRecord, derived: ReturnType<typeof reconcile>): void {
  const badges = derived.badges.map((b) => b.label).join(', ') || '-';
  console.log(`#${task.issue}  ${task.title}`);
  console.log(`  phase    ${derived.derivedPhase}${derived.displayPhase !== derived.derivedPhase ? ` (shown as ${derived.displayPhase})` : ''}`);
  console.log(`  badges   ${badges}`);
  console.log(`  needsYou ${derived.needsYou}${derived.needsYouReason ? ` — ${derived.needsYouReason}` : ''}`);
  const open = Object.entries(derived.gates)
    .filter(([, satisfied]) => satisfied)
    .map(([phase]) => phase)
    .join(', ');
  console.log(`  gates    ${open || 'none'}`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help') {
    console.log('commands: doctor | issues | import <issue> | forget <issue> | facts <issue> | reconcile <issue> | list | spawn <issue> <phase>');
    return;
  }

  const config = loadConfig();

  switch (command) {
    case 'doctor':
      return doctor(config);

    case 'issues': {
      for (const issue of await listOpenIssues(config)) {
        console.log(`#${issue.number}  ${issue.title}`);
      }
      return;
    }

    case 'import': {
      const issue = Number(rest[0]);
      if (!Number.isInteger(issue)) die('usage: import <issue>');
      return importIssue(config, issue);
    }

    case 'forget': {
      const issue = Number(rest[0]);
      if (!Number.isInteger(issue)) die('usage: forget <issue>');
      removeTask(issue);
      console.log(`removed #${issue} from the board`);
      return;
    }

    case 'facts': {
      const task = requireTask(Number(rest[0]));
      const branches = new Set(await listBranches(config));
      const batch = await fetchBranchPrs(config, [task.branch]);
      console.log(
        JSON.stringify(await gatherFacts(config, task, branches, batch), null, 2),
      );
      return;
    }

    case 'reconcile': {
      const task = requireTask(Number(rest[0]));
      const branches = new Set(await listBranches(config));
      const batch = await fetchBranchPrs(config, [task.branch]);
      const facts = await gatherFacts(config, task, branches, batch);
      printDerived(task, reconcile(facts, task.manualPhase));
      return;
    }

    case 'list': {
      const tasks = listTasks();
      if (tasks.length === 0) {
        console.log('board is empty (run: mc import <issue>)');
        return;
      }
      const branches = new Set(await listBranches(config));
      // One batched call for every board branch, mirroring the poller.
      const batch = await fetchBranchPrs(config, [
        ...new Set(tasks.map((t) => t.branch)),
      ]);
      for (const task of tasks) {
        const facts = await gatherFacts(config, task, branches, batch);
        printDerived(task, reconcile(facts, task.manualPhase));
        console.log('');
      }
      return;
    }

    case 'spawn': {
      const task = requireTask(Number(rest[0]));
      const phaseId = rest[1];
      const phase = config.pipeline.find((p) => p.id === phaseId);
      if (!phase) die(`unknown phase '${phaseId}'. known: ${config.pipeline.map((p) => p.id).join(', ')}`);
      const record = await spawnPhase(config, task, phase, {
        customInstructions: rest.slice(2).join(' ') || undefined,
      });
      upsertTask({ ...task, spawnHistory: [...task.spawnHistory, record] });
      console.log(`spawned ${phase.id} for #${task.issue} in a new terminal tab`);
      console.log(record.command);
      return;
    }

    default:
      die(`unknown command '${command}'`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
