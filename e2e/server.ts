/**
 * Mission Control's real HTTP app over a throwaway project, for Playwright.
 *
 * Everything the UI talks to is the production code: the routes, the notes
 * service, prompt rendering from the shipped command templates, and the
 * shipped config template. Only the facts that would come from git, gh and T3
 * are fixed, and fed through the real reconcile, so every card lands in the
 * lane production would put it in. Nothing here reaches the network; the two
 * GitHub-backed endpoints (review requests, the issue picker) are answered in
 * the browser by the tests.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'mc-e2e-'));
process.env.MC_ROOT = root;
process.env.MC_HOME = join(root, 'projects', 'acme__widgets');
process.env.T3_HOME = join(root, 't3');
process.env.MC_CLAUDE_COMMANDS = resolve('assets/claude/commands');

// Imported after the environment is set: paths resolve from it.
const { configPath, mcHome } = await import('../src/orchestrator/paths.ts');
const { exampleConfigPath, renderConfigTemplate } = await import('../src/orchestrator/init.ts');
const { loadConfig } = await import('../src/orchestrator/config.ts');
const { loadState, newTask, upsertTask } = await import('../src/orchestrator/state.ts');
const { writePlan } = await import('../src/orchestrator/plan.ts');
const { reconcile } = await import('../src/orchestrator/reconcile.ts');
const { toEditorIntegration } = await import('../src/orchestrator/editor-integration.ts');
const { pinnedFor } = await import('../src/orchestrator/poller.ts');
const { createApp } = await import('../src/server/app.ts');
const { createHealthResponse } = await import('../src/server/health.ts');
const { Broadcaster } = await import('../src/server/sse.ts');
const { buildStack } = await import('../src/shared/pr-stack.ts');
type Facts = import('../src/shared/types.ts').Facts;
type Phase = import('../src/shared/types.ts').Phase;

const repoPath = join(root, 'widgets');
mkdirSync(repoPath, { recursive: true });
mkdirSync(mcHome(), { recursive: true });
writeFileSync(
  configPath(),
  renderConfigTemplate(readFileSync(exampleConfigPath(), 'utf8'), {
    path: repoPath,
    owner: 'acme',
    name: 'widgets',
    baseBranch: 'main',
    branchPrefix: 'alice',
  }),
);
const config = loadConfig();

function facts(issue: number, over: Partial<Facts> = {}): Facts {
  return {
    issue,
    worktreeExists: false,
    branchExists: false,
    markers: [],
    planMdExists: false,
    artifacts: [],
    hasPushedCommits: false,
    dirtyFileCount: 0,
    unpushedCommits: 0,
    liveSpawn: null,
    pr: { exists: false, number: null, url: null, state: null },
    checks: 'none',
    review: { decision: 'NONE', unresolvedThreads: 0, copilotUnresolved: 0 },
    ...over,
  };
}

/** The board: one task per stage the smoke tests look at. */
const FIXTURES: Array<{ issue: number; title: string; facts: Facts; manualPhase?: Phase }> = [
  { issue: 101, title: 'Add audio playback mode', facts: facts(101) },
  {
    // Held in Plan, which is where a finished plan waits for your review.
    issue: 102,
    title: 'Add progress bar',
    facts: facts(102, { planMdExists: true, markers: ['plan.done'], worktreeExists: true, branchExists: true }),
    manualPhase: 'plan',
  },
  {
    issue: 103,
    title: 'Fix sign-in redirect',
    facts: facts(103, {
      planMdExists: true,
      markers: ['plan.done'],
      worktreeExists: true,
      branchExists: true,
      hasPushedCommits: true,
      pr: { exists: true, number: 7, url: 'https://github.com/acme/widgets/pull/7', state: 'OPEN' },
      checks: 'failure',
    }),
  },
];

for (const fixture of FIXTURES) {
  const task = newTask(fixture.issue, fixture.title, 'alice');
  task.manualPhase = fixture.manualPhase ?? null;
  if (fixture.issue === 103) {
    task.stack = { discoveryComplete: true, selectedKey: 'github.com/acme/widgets/6', layers: [6, 7, 8].map(number => ({
      host: 'github.com', repository: 'acme/widgets', number,
      title: number === 7 ? 'Prepare redirect handling' : 'Complete redirect flow',
      url: `https://github.com/acme/widgets/pull/${number}`, state: number === 6 ? 'MERGED' : 'OPEN',
      headRepository: 'acme/widgets', baseRepository: 'acme/widgets', headBranch: `alice/layer-${number}`,
      baseBranch: number === 7 ? 'main' : 'alice/layer-7', headSha: 'a'.repeat(40),
      checks: number === 7 ? 'failure' : 'success',
      review: { decision: 'APPROVED', unresolvedThreads: 0, copilotUnresolved: 0 }, available: true,
      source: 'attached', checkedAt: new Date().toISOString(),
    })) };
  }
  upsertTask(task);
}
writePlan(102, '# Plan for #102\n\nAdd a progress bar to the lesson header.\n');

const broadcaster = new Broadcaster();
async function refresh() {
  const state = loadState();
  const tasks = state.tasks.map((task) => {
    const taskFacts = { ...(FIXTURES.find((f) => f.issue === task.issue)?.facts ?? facts(task.issue)),
      ...(task.stack ? { stack: buildStack(task.stack.layers, config.repo.baseBranch, task.stack.discoveryComplete) } : {}) };
    const derived = reconcile(taskFacts, task.manualPhase);
    return {
      ...task,
      derived,
      integration: toEditorIntegration(taskFacts),
      pinned: pinnedFor(config, task, derived, state.phaseDefaults ?? {}),
    };
  });
  broadcaster.send('tasks', tasks);
  return tasks;
}

const app = await createApp({
  config,
  broadcaster,
  refresh,
  health: createHealthResponse('e2e'),
});
const port = Number(process.env.MC_PORT ?? 4399);
await app.listen({ port, host: '127.0.0.1' });
console.log(`e2e server on http://127.0.0.1:${port} (${root})`);

const shutdown = async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
