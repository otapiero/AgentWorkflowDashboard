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
import { fetchIssueTitle, listOpenIssues } from './github.ts';
import { createStackCollector } from './github-stack.ts';
import { spawnPhase } from './spawn/phase.ts';
import { collectArtifacts } from './artifacts.ts';
import { listBranches, resolveBranch } from './worktree.ts';
import {
  activeProjectSlug,
  listProjects,
  mcHome,
  mcRoot,
  projectHome,
  setActiveProject,
} from './paths.ts';
import { detectRepo, initProject } from './init.ts';
import { T3Client } from './t3/client.ts';
import { readInstanceReadiness } from './t3/instances.ts';
import { formatT3Doctor } from './t3/doctor.ts';
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
  console.log(`root        ${mcRoot()}`);
  console.log(`project     ${activeProjectSlug()}`);
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

  console.log('');

  const client = new T3Client();
  const t3Instances = Object.entries(config.agents)
    .filter(([, profile]) => profile.t3Instance)
    .map(([agent, profile]) => {
      const readiness = readInstanceReadiness(profile.t3Instance!);
      return {
        agent,
        instanceId: readiness.instanceId,
        ready: readiness.ready,
        reason: readiness.reason,
        models: readiness.models,
      };
    });

  for (const line of formatT3Doctor({
    status: await client.status(),
    pinnedVersion: config.t3?.pinnedVersion,
    instances: t3Instances,
  })) {
    console.log(line);
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
    console.log('commands: init | project [list|use <slug>] | mcp --project <slug> --server-url <loopback-url> | doctor | issues | import <issue> | forget <issue> | facts <issue> | reconcile <issue> | list | spawn <issue> <phase> | collect <issue>');
    return;
  }

  // Commands that run *before* a config exists must be handled here — the
  // loadConfig() below is exactly what they are there to make possible.
  if (command === 'mcp') {
    const options: Record<string, string> = {};
    for (let index = 0; index < rest.length; index += 2) {
      const flag = rest[index]; const value = rest[index + 1];
      if (!flag || !['--project', '--server-url'].includes(flag) || !value || value.startsWith('--') || flag in options) {
        die('usage: mcp --project <slug> --server-url <loopback-url>');
      }
      options[flag] = value;
    }
    if (!options['--project'] || !options['--server-url']) die('usage: mcp --project <slug> --server-url <loopback-url>');
    const { runNotesMcp } = await import('../mcp/server.ts');
    runNotesMcp({ projectId: options['--project'], serverUrl: options['--server-url'] });
    return;
  }

  if (command === 'init') {
    const repo = await detectRepo(process.cwd());
    const { slug, configPath } = initProject(repo, { force: rest.includes('--force') });
    console.log(`project  ${slug}  (now active)`);
    console.log(`repo     ${repo.owner}/${repo.name}  (base ${repo.baseBranch})`);
    console.log(`path     ${repo.path}`);
    console.log(`branches ${repo.branchPrefix}/<issue>-<slug>`);
    console.log(`config   ${configPath}`);
    console.log('');
    console.log('Review the config, then run: npm start');
    return;
  }

  if (command === 'project') {
    const [action, slug] = rest;

    if (!action || action === 'list') {
      const projects = listProjects();
      if (projects.length === 0) {
        console.log('no projects yet (run: npm run mc -- init)');
        return;
      }
      // Resolution can legitimately fail here (several projects, no choice),
      // and listing them is exactly how you recover from that.
      let active = '';
      try {
        active = activeProjectSlug();
      } catch {
        active = '';
      }
      for (const project of projects) {
        console.log(`${project === active ? '*' : ' '} ${project}  ${projectHome(project)}`);
      }
      return;
    }

    if (action === 'use') {
      if (!slug) die('usage: project use <slug>');
      if (!listProjects().includes(slug)) {
        die(`unknown project '${slug}'. known: ${listProjects().join(', ') || 'none'}`);
      }
      setActiveProject(slug);
      console.log(`active project is now ${slug}`);
      console.log('Restart the server for it to take effect.');
      return;
    }

    die('usage: project [list] | project use <slug>');
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
      const batch = await createStackCollector(config).collect([task]);
      console.log(
        JSON.stringify(await gatherFacts(config, task, branches, batch), null, 2),
      );
      return;
    }

    case 'reconcile': {
      const task = requireTask(Number(rest[0]));
      const branches = new Set(await listBranches(config));
      const batch = await createStackCollector(config).collect([task]);
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
      // One batched call for every unmerged issue, mirroring the poller.
      const batch = await createStackCollector(config).collect(tasks);
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
      const current = getTask(task.issue);
      if (current) upsertTask({ ...current, spawnHistory: [...current.spawnHistory, record] });
      console.log(`spawned ${phase.id} for #${task.issue} in a new terminal tab`);
      console.log(record.command);
      return;
    }

    case 'collect': {
      const task = requireTask(Number(rest[0]));
      const refs = await collectArtifacts(config, task.issue, 'plan', 'command');
      console.log(`collected ${refs.length} artifact(s) for #${task.issue}`);
      for (const r of refs) console.log(`  ${r.origin.padEnd(7)} ${r.name}`);
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
