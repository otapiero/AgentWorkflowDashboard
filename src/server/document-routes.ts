import type { FastifyInstance } from 'fastify';

import {
  readArtifactDocument,
  writeArtifactDocument,
  type DocumentError,
} from '../orchestrator/documents.ts';
import { readPlan, writePlan } from '../orchestrator/plan.ts';
import { openArtifactInEditor, openWorktreeInVscode } from '../orchestrator/spawn/launchers.ts';
import { missionUsage } from '../orchestrator/usage.ts';
import { errorMessage, findTask } from './route-helpers.ts';

/** How a document failure surfaces over HTTP. */
const DOCUMENT_FAILURE: Record<DocumentError, { status: number; error: string }> = {
  'not-found': { status: 404, error: 'no such artifact for this task' },
  gone: { status: 410, error: 'the artifact is no longer on disk' },
  'too-large': { status: 413, error: 'artifact is larger than the 2 MB editing limit' },
  binary: { status: 415, error: 'artifact is not text' },
};

/** A task's plan and collected artifacts, its usage, and the shortcuts into the editor. */
export function registerDocumentRoutes(app: FastifyInstance): void {
  app.get<{ Params: { issue: string } }>('/api/tasks/:issue/plan', async (req, reply) => {
    const content = readPlan(Number(req.params.issue));
    if (content === null) return reply.code(404).send({ error: 'no plan attached yet' });
    return { content };
  });

  app.put<{ Params: { issue: string }; Body: { content?: string } }>(
    '/api/tasks/:issue/plan',
    async (req, reply) => {
      const task = findTask(req.params.issue, reply);
      if (!task) return reply;
      if (typeof req.body?.content !== 'string') {
        return reply.code(400).send({ error: 'content must be a string' });
      }
      writePlan(task.issue, req.body.content);
      return { ok: true };
    },
  );

  app.get<{ Params: { issue: string } }>('/api/tasks/:issue/usage', async (req, reply) => {
    const task = findTask(req.params.issue, reply);
    if (!task) return reply;
    return missionUsage(task.issue);
  });

  app.post<{ Params: { issue: string }; Body: { layerKey?: string } }>(
    '/api/tasks/:issue/open-code',
    async (req, reply) => {
      const task = findTask(req.params.issue, reply);
      if (!task) return reply;
      try {
        openWorktreeInVscode(task.issue);
        return { ok: true };
      } catch (err) {
        return reply.code(400).send({ error: errorMessage(err) });
      }
    },
  );

  app.post<{ Params: { issue: string; name: string } }>(
    '/api/tasks/:issue/artifacts/:name/open',
    async (req, reply) => {
      const task = findTask(req.params.issue, reply);
      if (!task) return reply;
      try {
        openArtifactInEditor(task.issue, decodeURIComponent(req.params.name));
        return { ok: true };
      } catch (err) {
        return reply.code(400).send({ error: errorMessage(err) });
      }
    },
  );

  app.get<{ Params: { issue: string; name: string } }>(
    '/api/tasks/:issue/artifacts/:name',
    async (req, reply) => {
      const task = findTask(req.params.issue, reply);
      if (!task) return reply;

      const result = readArtifactDocument(task.issue, decodeURIComponent(req.params.name));
      if (!result.ok) {
        const failure = DOCUMENT_FAILURE[result.error];
        return reply.code(failure.status).send({ error: failure.error, reason: result.error });
      }
      return result.value;
    },
  );

  app.put<{ Params: { issue: string; name: string }; Body: { content?: unknown } }>(
    '/api/tasks/:issue/artifacts/:name',
    async (req, reply) => {
      const task = findTask(req.params.issue, reply);
      if (!task) return reply;
      if (typeof req.body?.content !== 'string') {
        return reply.code(400).send({ error: 'content must be a string' });
      }

      const result = writeArtifactDocument(
        task.issue,
        decodeURIComponent(req.params.name),
        req.body.content,
      );
      if (!result.ok) {
        const failure = DOCUMENT_FAILURE[result.error];
        return reply.code(failure.status).send({ error: failure.error, reason: result.error });
      }
      return { ok: true, writeTarget: result.value };
    },
  );
}
