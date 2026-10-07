import type { FastifyInstance } from 'fastify';
import { NotesError } from '../orchestrator/notes.ts';
import type { NotesService } from '../orchestrator/notes.ts';

export function registerNotesRoutes(app: FastifyInstance, { service }: { service: NotesService }): void {
  const run = async (operation: () => unknown, reply: { code(status: number): { send(body: unknown): unknown } }) => {
    try { return await operation(); }
    catch (error) {
      if (!(error instanceof NotesError)) throw error;
      return reply.code(error.statusCode).send({ code: error.code, error: error.message,
        ...(error.currentNote ? { currentNote: error.currentNote } : {}) });
    }
  };
  type Query = { projectId?: string };
  app.get<{ Querystring: Query }>('/api/notes', (req, reply) => run(() => {
    service.assertProject(req.query.projectId); return service.snapshot();
  }, reply));
  app.get<{ Querystring: Query }>('/api/notes/tasks', (req, reply) => run(() => {
    service.assertProject(req.query.projectId); return { projectId: service.projectId, tasks: service.tasks() };
  }, reply));
  app.get<{ Params: { id: string }; Querystring: Query }>('/api/notes/:id', (req, reply) => run(() => {
    service.assertProject(req.query.projectId); return service.get(req.params.id);
  }, reply));
  app.post('/api/notes', (req, reply) => run(() => service.create(req.body), reply));
  app.patch<{ Params: { id: string } }>('/api/notes/:id', (req, reply) => run(() => service.update(req.params.id, req.body), reply));
}
