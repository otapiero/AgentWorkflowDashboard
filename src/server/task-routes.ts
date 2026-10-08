import type { FastifyInstance } from 'fastify';

import { fetchIssueTitle, listOpenIssues } from '../orchestrator/github.ts';
import { writeMarker, clearMarker } from '../orchestrator/markers.ts';
import { mergeOverrides } from '../orchestrator/overrides.ts';
import { getTask, newTask, removeTask, upsertTask } from '../orchestrator/state.ts';
import { removeWorktree, resolveBranch, worktreeExists } from '../orchestrator/worktree.ts';
import { shouldCleanupOnDone } from '../orchestrator/cleanup.ts';
import { PHASES } from '../shared/types.ts';
import type { Phase } from '../shared/types.ts';
import { errorMessage, findTask, type RouteContext } from './route-helpers.ts';

function isPhase(value: unknown): value is Phase {
  return typeof value === 'string' && (PHASES as readonly string[]).includes(value);
}

/** The board itself: listing, importing, moving, marking done, overriding, removing. */
export function registerTaskRoutes(
  app: FastifyInstance,
  { config, refresh, cleanupTask }: Pick<RouteContext, 'config' | 'refresh' | 'cleanupTask'>,
): void {
  app.get('/api/tasks', async () => refresh());

  app.get<{ Querystring: { scope?: string } }>('/api/issues', async (req) =>
    // Default to the current user's issues; that is the common case and keeps
    // the picker short. scope=all lists every open issue.
    listOpenIssues(config, { mine: req.query?.scope !== 'all' }),
  );

  app.post<{ Body: { issue?: number } }>('/api/tasks/import', async (req, reply) => {
    const issue = Number(req.body?.issue);
    if (!Number.isInteger(issue) || issue <= 0) {
      return reply.code(400).send({ error: 'issue must be a positive integer' });
    }
    if (getTask(issue)) {
      return reply.code(409).send({ error: `#${issue} is already on the board` });
    }

    const title = await fetchIssueTitle(config, issue);
    if (!title) {
      return reply
        .code(404)
        .send({ error: `issue #${issue} not found in ${config.repo.owner}/${config.repo.name}` });
    }

    const task = newTask(issue, title, config.repo.branchPrefix);
    // An existing branch for this issue wins over the generated slug.
    upsertTask({ ...task, branch: await resolveBranch(config, issue, task.branch) });
    return refresh();
  });

  app.post<{ Params: { issue: string }; Body: { phase?: string } }>(
    '/api/tasks/:issue/mark-done',
    async (req, reply) => {
      const task = findTask(req.params.issue, reply);
      if (!task) return reply;
      if (!isPhase(req.body?.phase)) {
        return reply.code(400).send({ error: 'phase is required' });
      }
      writeMarker(task.issue, `${req.body.phase}.done`);
      return refresh();
    },
  );

  app.post<{ Params: { issue: string }; Body: { phase?: string } }>(
    '/api/tasks/:issue/unmark-done',
    async (req, reply) => {
      const task = findTask(req.params.issue, reply);
      if (!task) return reply;
      if (!isPhase(req.body?.phase)) {
        return reply.code(400).send({ error: 'phase is required' });
      }
      clearMarker(task.issue, `${req.body.phase}.done`);
      return refresh();
    },
  );

  app.post<{ Params: { issue: string }; Body: { phase?: string | null } }>(
    '/api/tasks/:issue/move',
    async (req, reply) => {
      const task = findTask(req.params.issue, reply);
      if (!task) return reply;

      const phase = req.body?.phase;
      // null clears the override and lets derivation take over again.
      if (phase !== null && !isPhase(phase)) {
        return reply.code(400).send({ error: 'phase must be a valid phase or null' });
      }

      // Marking a task done is the operator saying the work is finished, so
      // this is where its checkout is retired. Derivation is deliberately not
      // the trigger: a merged PR is GitHub's opinion, and the operator may
      // still be using the worktree for something.
      if (phase && shouldCleanupOnDone(config, phase, worktreeExists(task.issue))) {
        try {
          const result = await cleanupTask(config, task.issue, task.branch);
          const extras = [
            result.rescued.length ? `rescued ${result.rescued.length} file(s)` : null,
            result.branchDeleted ? `deleted ${task.branch}` : null,
          ].filter(Boolean);
          console.log(
            `[mc] #${task.issue} marked done - removed its worktree${extras.length ? ` (${extras.join(', ')})` : ''}`,
          );
        } catch (e) {
          console.error(`[mc] worktree cleanup failed for #${task.issue}:`, e);
          return reply.code(500).send({
            error: `Could not mark Done: ${errorMessage(e)}. Retry after closing anything using the worktree.`,
          });
        }
      }

      upsertTask({ ...getTask(task.issue)!, manualPhase: phase ?? null });
      return refresh();
    },
  );

  app.post<{
    Params: { issue: string };
    Body: {
      agent?: string | null;
      model?: string | null;
      effort?: string | null;
      instructions?: string | null;
    };
  }>('/api/tasks/:issue/overrides', async (req, reply) => {
    const task = findTask(req.params.issue, reply);
    if (!task) return reply;

    const agent = req.body?.agent;
    if (agent && !config.agents[agent]) {
      return reply.code(400).send({ error: `unknown agent '${agent}'` });
    }
    upsertTask({
      ...task,
      overrides: mergeOverrides(task.overrides, req.body ?? {}),
    });
    return refresh();
  });

  app.post('/api/reconcile', async () => refresh());

  app.post<{ Params: { issue: string } }>(
    '/api/tasks/:issue/cleanup',
    async (req, reply) => {
      const task = findTask(req.params.issue, reply);
      if (!task) return reply;
      // Only removes Mission Control's own worktree; the repo is untouched.
      await removeWorktree(config, task.issue);
      return refresh();
    },
  );

  app.delete<{ Params: { issue: string } }>('/api/tasks/:issue', async (req) => {
    removeTask(Number(req.params.issue));
    return refresh();
  });
}
