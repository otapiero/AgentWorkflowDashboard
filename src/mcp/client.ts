import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { noteCreateSchema, noteUpdateSchema, noteIdSchema, noteResponseSchema,
  noteResultSchema, notesSnapshotSchema, noteTasksResponseSchema } from '../shared/notes.ts';
import type { Note, NoteCreateInput, NoteUpdateInput } from '../shared/notes.ts';

export interface NotesMcpOptions { projectId: string; serverUrl: string; timeoutMs?: number }
export class NotesApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly currentNote?: Note,
    public clientRequestId?: string) { super(message); }
}
const errorSchema = z.object({ code: z.string().min(1), error: z.string().min(1), currentNote: noteResponseSchema.optional() }).strict();

export class NotesApiClient {
  readonly projectId: string;
  private readonly origin: string;
  private readonly timeoutMs: number;
  constructor(options: NotesMcpOptions) {
    const url = new URL(options.serverUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('server-url must be a loopback HTTP origin such as http://127.0.0.1:4317');
    }
    if (!options.projectId.trim()) throw new Error('project is required');
    this.projectId = options.projectId;
    this.origin = url.origin;
    this.timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('timeoutMs must be positive');
  }
  private async request<T extends { projectId: string }>(path: string, schema: z.ZodType<T>, method = 'GET', body?: unknown): Promise<T> {
    const url = new URL(path, this.origin);
    // Reads and writes both carry the pinned repository in the query. The body
    // additionally supplies it for the backend's mutation validation.
    url.searchParams.set('projectId', this.projectId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { method, redirect: 'manual', signal: controller.signal,
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new NotesApiError('MC_INVALID_RESPONSE', 'Mission Control returned a redirect; no redirect was followed.');
      }
      if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
        await response.body?.cancel();
        throw new NotesApiError('MC_INVALID_RESPONSE', 'Mission Control did not return JSON. Check server-url.');
      }
      let data: unknown;
      try { data = await response.json(); }
      catch (error) {
        if (controller.signal.aborted) throw error;
        throw new NotesApiError('MC_INVALID_RESPONSE', 'Mission Control returned unreadable JSON.');
      }
      if (!response.ok) {
        const parsed = errorSchema.safeParse(data);
        if (!parsed.success) throw new NotesApiError('MC_INVALID_RESPONSE', 'Mission Control returned an invalid error response.');
        const { code, error, currentNote } = parsed.data;
        throw new NotesApiError(code === 'NOTE_TASK_NOT_FOUND' ? 'TASK_NOT_FOUND' : code, error, currentNote);
      }
      const parsed = schema.safeParse(data);
      if (!parsed.success) throw new NotesApiError('MC_INVALID_RESPONSE', 'Mission Control returned an invalid notes response.');
      if (parsed.data.projectId !== this.projectId) throw new NotesApiError('NOTES_PROJECT_MISMATCH', `Expected repository ${this.projectId}.`);
      return parsed.data;
    } catch (error) {
      if (error instanceof NotesApiError) throw error;
      throw new NotesApiError('MC_UNAVAILABLE', `Mission Control is unreachable or timed out at ${this.origin}. Start its server for ${this.projectId}.`);
    } finally { clearTimeout(timer); }
  }
  tasks() { return this.request('/api/notes/tasks', noteTasksResponseSchema); }
  list() { return this.request('/api/notes', notesSnapshotSchema); }
  async get(id: string) {
    noteIdSchema.parse(id);
    const result = await this.request(`/api/notes/${id}`, noteResultSchema);
    if (result.note.id !== id) throw new NotesApiError('MC_INVALID_RESPONSE', 'Mission Control returned a different note.');
    return result;
  }
  async create(input: Omit<NoteCreateInput, 'projectId' | 'clientRequestId'> & { clientRequestId?: string }) {
    const body = noteCreateSchema.parse({ ...input, taskIssue: input.taskIssue ?? null,
      clientRequestId: input.clientRequestId ?? randomUUID(), projectId: this.projectId });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await this.request('/api/notes', noteResultSchema, 'POST', body);
        if (result.note.clientRequestId !== body.clientRequestId) throw new NotesApiError('MC_INVALID_RESPONSE', 'Mission Control acknowledged a different creation request.');
        return result;
      } catch (error) {
        if (!(error instanceof NotesApiError)) throw error;
        error.clientRequestId = body.clientRequestId;
        if (error.code !== 'MC_UNAVAILABLE' || attempt === 1) throw error;
      }
    }
    throw new Error('Unreachable creation retry');
  }
  async update(id: string, input: Omit<NoteUpdateInput, 'projectId'>) {
    noteIdSchema.parse(id);
    const body = noteUpdateSchema.parse({ ...input, projectId: this.projectId });
    // Mutations with revisions are never retried automatically. An uncertain
    // update requires reading the latest note before deciding what to do next.
    const result = await this.request(`/api/notes/${id}`, noteResultSchema, 'PATCH', body);
    if (result.note.id !== id) throw new NotesApiError('MC_INVALID_RESPONSE', 'Mission Control returned a different note.');
    return result;
  }
}
