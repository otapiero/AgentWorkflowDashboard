import { randomUUID, createHash } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { MAX_NOTE_BODY_BYTES, noteBodySchema, noteCreateSchema, noteIdSchema, noteTaskIssueSchema,
  noteTitleSchema, noteUpdateSchema } from '../shared/notes.ts';
import type { Note, NoteResult, NoteTask, NotesSnapshot, NotesStatus } from '../shared/notes.ts';
import { acquireNotesLease } from './notes-lease.ts';

export class NotesError extends Error {
  constructor(public code: string, message: string, public statusCode: number, public currentNote?: Note) { super(message); }
}
const recordSchema = z.object({
  id: z.uuid(), title: noteTitleSchema, body: noteBodySchema,
  taskIssue: noteTaskIssueSchema, taskTitleAtLink: z.string().nullable(), status: z.enum(['active', 'settled']),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), settledAt: z.iso.datetime().nullable(),
  revision: z.number().int().positive(), clientRequestId: z.uuid(), creationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(value => (value.status === 'active') === (value.settledAt === null), 'Invalid settlement timestamp')
  .refine(value => (value.taskIssue === null) === (value.taskTitleAtLink === null), 'Invalid task title snapshot');
const fileSchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), notes: z.array(recordSchema) }).strict()
  .refine(value => new Set(value.notes.map(note => note.id)).size === value.notes.length, 'Duplicate note IDs')
  .refine(value => new Set(value.notes.map(note => note.clientRequestId)).size === value.notes.length, 'Duplicate request IDs');
type StoredNote = z.infer<typeof recordSchema>;
type NotesFile = z.infer<typeof fileSchema>;
interface Options {
  home: string; projectId: string; tasks: () => NoteTask[];
  onSnapshot?: (value: NotesSnapshot) => void; onStatus?: (value: NotesStatus) => void;
}
function publicNote({ creationFingerprint: _private, ...note }: StoredNote): Note { return { ...note }; }

export class NotesService {
  readonly projectId: string;
  readonly serverSessionId = randomUUID();
  private readonly home: string;
  private readonly file: string;
  private data: NotesFile = { version: 1, revision: 0, notes: [] };
  private unavailable: NotesError | null = new NotesError('NOTES_UNAVAILABLE', 'Notes service has not started', 503);
  private release?: () => Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private started = false;
  private closing = false;
  constructor(private readonly options: Options) {
    this.home = resolve(options.home);
    this.file = join(this.home, 'notes.json');
    this.projectId = options.projectId;
  }
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      this.release = await acquireNotesLease(this.home, error => {
        this.unavailable = new NotesError('NOTES_LEASE_LOST', error.message, 503);
        this.publishStatus();
      });
      let text: string | null = null;
      try { text = await readFile(this.file, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (text !== null) {
        try { this.data = fileSchema.parse(JSON.parse(text)); }
        catch { throw new NotesError('NOTES_STORE_INVALID', 'notes.json is unreadable or unsupported. The original file was preserved.', 503); }
      }
      this.unavailable = null;
      this.publishStatus();
      this.options.onSnapshot?.(await this.snapshot());
    } catch (error) {
      this.unavailable = error instanceof NotesError ? error : new NotesError(
        (error as NodeJS.ErrnoException).code === 'NOTES_ALREADY_OPEN' ? 'NOTES_ALREADY_OPEN' : 'NOTES_UNAVAILABLE',
        error instanceof Error ? error.message : String(error), 503);
      this.publishStatus();
    }
  }
  private publishStatus(): void {
    this.options.onStatus?.({ projectId: this.projectId, serverSessionId: this.serverSessionId,
      available: !this.unavailable, ...(this.unavailable ? { code: this.unavailable.code, error: this.unavailable.message } : {}) });
  }
  assertProject(projectId?: unknown): void {
    if (projectId !== undefined && projectId !== this.projectId) throw new NotesError('NOTES_PROJECT_MISMATCH', `Expected repository ${this.projectId}`, 409);
  }
  private ready(): void {
    if (this.unavailable) throw this.unavailable;
    if (this.closing) throw new NotesError('NOTES_UNAVAILABLE', 'Notes service is closing', 503);
  }
  tasks(): NoteTask[] { this.ready(); return this.options.tasks().map(({ issue, title }) => ({ issue, title })); }
  async snapshot(): Promise<NotesSnapshot> {
    this.ready();
    return { projectId: this.projectId, serverSessionId: this.serverSessionId, revision: this.data.revision, notes: this.data.notes.map(publicNote) };
  }
  private result(note: StoredNote): NoteResult { return { projectId: this.projectId, serverSessionId: this.serverSessionId, note: publicNote(note) }; }
  async get(id: string): Promise<NoteResult> {
    this.ready();
    this.validateId(id);
    const note = this.data.notes.find(note => note.id === id);
    if (!note) throw new NotesError('NOTE_NOT_FOUND', 'Note was not found', 404);
    return this.result(note);
  }
  private validateId(id: string): void {
    if (!noteIdSchema.safeParse(id).success) throw new NotesError('NOTES_INVALID_INPUT', 'Note ID must be a UUID', 400);
  }
  private parse<T>(schema: z.ZodType<T>, input: unknown): T {
    if (typeof input === 'object' && input !== null && 'body' in input && typeof input.body === 'string'
      && Buffer.byteLength(input.body, 'utf8') > MAX_NOTE_BODY_BYTES) throw new NotesError('NOTES_TOO_LARGE', 'Body exceeds 64 KiB', 413);
    const result = schema.safeParse(input);
    if (!result.success) throw new NotesError('NOTES_INVALID_INPUT', result.error.issues.map(issue => issue.message).join('; '), 400);
    return result.data;
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private taskTitle(issue: number | null): string | null {
    if (issue === null) return null;
    const task = this.options.tasks().find(task => task.issue === issue);
    if (!task) throw new NotesError('NOTE_TASK_NOT_FOUND', `Task #${issue} is not on this repository's board`, 404);
    return task.title;
  }
  async create(input: unknown): Promise<NoteResult> {
    const parsed = this.parse(noteCreateSchema, input);
    this.assertProject(parsed.projectId);
    return this.serialize(async () => {
      this.ready();
      const normalized = { title: parsed.title ?? null, body: parsed.body, taskIssue: parsed.taskIssue ?? null };
      const fingerprint = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
      const existing = this.data.notes.find(note => note.clientRequestId === parsed.clientRequestId);
      if (existing) {
        if (existing.creationFingerprint !== fingerprint) throw new NotesError('NOTE_REQUEST_CONFLICT', 'Creation request ID was already used for different content', 409);
        return this.result(existing);
      }
      const title = this.taskTitle(normalized.taskIssue);
      const now = new Date().toISOString();
      const note: StoredNote = { ...normalized, id: randomUUID(), taskTitleAtLink: title, status: 'active', createdAt: now,
        updatedAt: now, settledAt: null, revision: 1, clientRequestId: parsed.clientRequestId, creationFingerprint: fingerprint };
      await this.commit({ version: 1, revision: this.data.revision + 1, notes: [...this.data.notes, note] });
      return this.result(note);
    });
  }
  async update(id: string, input: unknown): Promise<NoteResult> {
    this.validateId(id);
    const parsed = this.parse(noteUpdateSchema, input);
    this.assertProject(parsed.projectId);
    return this.serialize(async () => {
      this.ready();
      const current = this.data.notes.find(note => note.id === id);
      if (!current) throw new NotesError('NOTE_NOT_FOUND', 'Note was not found', 404);
      if (parsed.expectedRevision !== current.revision) throw new NotesError('NOTE_REVISION_CONFLICT', 'Note changed since it was loaded', 409, publicNote(current));
      const next = { ...current };
      if (parsed.title !== undefined) next.title = parsed.title;
      if (parsed.body !== undefined) next.body = parsed.body;
      if (parsed.taskIssue !== undefined && parsed.taskIssue !== current.taskIssue) {
        next.taskTitleAtLink = this.taskTitle(parsed.taskIssue);
        next.taskIssue = parsed.taskIssue;
      }
      if (parsed.status !== undefined && parsed.status !== current.status) {
        next.status = parsed.status;
        next.settledAt = parsed.status === 'settled' ? new Date().toISOString() : null;
      }
      if (JSON.stringify(next) === JSON.stringify(current)) return this.result(current);
      next.updatedAt = new Date().toISOString();
      next.revision += 1;
      await this.commit({ version: 1, revision: this.data.revision + 1, notes: this.data.notes.map(note => note.id === id ? next : note) });
      return this.result(next);
    });
  }
  private async commit(next: NotesFile): Promise<void> {
    const temporary = join(this.home, `.notes-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx');
      try { await handle.writeFile(JSON.stringify(next, null, 2), 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      this.ready();
      await rename(temporary, this.file);
    } catch (error) {
      try { await unlink(temporary); } catch { /* Nothing committed. */ }
      throw error instanceof NotesError ? error : new NotesError('NOTES_WRITE_FAILED', `Could not save notes: ${error instanceof Error ? error.message : String(error)}`, 503);
    }
    this.data = next;
    this.options.onSnapshot?.(await this.snapshot());
  }
  async close(): Promise<void> {
    await this.queue;
    this.closing = true;
    await this.release?.();
    this.release = undefined;
  }
}
