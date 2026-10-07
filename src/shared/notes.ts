import { z } from 'zod';

export const MAX_NOTE_BODY_BYTES = 65536;
export const MAX_NOTE_TITLE_LENGTH = 240;
export type NoteStatus = 'active' | 'settled';
export interface Note {
  id: string; title: string | null; body: string;
  taskIssue: number | null; taskTitleAtLink: string | null;
  status: NoteStatus; createdAt: string; updatedAt: string;
  settledAt: string | null; revision: number; clientRequestId: string;
}
export interface NotesSnapshot {
  projectId: string; serverSessionId: string; revision: number; notes: Note[];
}
export interface NoteResult { projectId: string; serverSessionId: string; note: Note }
export interface NoteTask { issue: number; title: string }
export interface NotesStatus {
  projectId: string; serverSessionId: string; available: boolean;
  code?: string; error?: string;
}

export const noteIdSchema = z.uuid();
export const noteBodySchema = z.string().refine(value => value.trim().length > 0, 'Body is required')
  .refine(value => new TextEncoder().encode(value).length <= MAX_NOTE_BODY_BYTES, 'Body exceeds 64 KiB');
export const noteTitleSchema = z.string().max(MAX_NOTE_TITLE_LENGTH).nullable();
export const noteTaskIssueSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable();
export const noteCreateSchema = z.object({
  projectId: z.string().min(1), clientRequestId: z.uuid(),
  body: noteBodySchema, title: noteTitleSchema.optional(), taskIssue: noteTaskIssueSchema.optional(),
}).strict();
export const noteUpdateSchema = z.object({
  projectId: z.string().min(1), expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  title: noteTitleSchema.optional(), body: noteBodySchema.optional(),
  taskIssue: noteTaskIssueSchema.optional(), status: z.enum(['active', 'settled']).optional(),
}).strict().refine(value => ['title', 'body', 'taskIssue', 'status'].some(key => key in value), 'Supply at least one changed field');
export type NoteCreateInput = z.infer<typeof noteCreateSchema>;
export type NoteUpdateInput = z.infer<typeof noteUpdateSchema>;

// Public HTTP response contracts. Keep these browser-safe; private store metadata
// must never enter a tool result or a browser response through these schemas.
export const noteResponseSchema = z.object({
  id: noteIdSchema, title: noteTitleSchema, body: noteBodySchema,
  taskIssue: noteTaskIssueSchema, taskTitleAtLink: z.string().nullable(),
  status: z.enum(['active', 'settled']), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  settledAt: z.iso.datetime().nullable(), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  clientRequestId: z.uuid(),
}).strict().refine(value => (value.status === 'active') === (value.settledAt === null), 'Invalid settlement timestamp')
  .refine(value => (value.taskIssue === null) === (value.taskTitleAtLink === null), 'Invalid task title snapshot');
export const noteResultSchema = z.object({
  projectId: z.string().min(1), serverSessionId: z.uuid(), note: noteResponseSchema,
}).strict();
export const notesSnapshotSchema = z.object({
  projectId: z.string().min(1), serverSessionId: z.uuid(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), notes: z.array(noteResponseSchema),
}).strict().refine(value => new Set(value.notes.map(note => note.id)).size === value.notes.length, 'Duplicate note IDs')
  .refine(value => new Set(value.notes.map(note => note.clientRequestId)).size === value.notes.length, 'Duplicate request IDs');
export const noteTasksResponseSchema = z.object({
  projectId: z.string().min(1), tasks: z.array(z.object({
    issue: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), title: z.string(),
  }).strict()),
}).strict();
