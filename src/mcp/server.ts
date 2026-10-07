import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { noteCreateSchema, noteIdSchema, noteUpdateSchema, noteResultSchema,
  notesSnapshotSchema, noteTasksResponseSchema, noteTaskIssueSchema } from '../shared/notes.ts';
import type { NoteResult } from '../shared/notes.ts';
import { NotesApiClient, NotesApiError } from './client.ts';
import type { NotesMcpOptions } from './client.ts';

const reads = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const writes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const searchSchema = z.string().optional();
const listSchema = z.object({ scope: z.enum(['all', 'general', 'task']).default('all'),
  taskIssue: noteTaskIssueSchema.unwrap().optional(),
  status: z.enum(['active', 'settled', 'all']).default('active'), search: searchSchema,
}).strict().refine(value => value.scope === 'task' ? value.taskIssue !== undefined : value.taskIssue === undefined,
  'Supply taskIssue only with scope task; task scope requires a GitHub issue number');
const createSchema = noteCreateSchema.omit({ projectId: true }).extend({ clientRequestId: z.uuid().optional() });
const updateSchema = z.object({ id: noteIdSchema, expectedRevision: noteUpdateSchema.shape.expectedRevision,
  title: noteUpdateSchema.shape.title, body: noteUpdateSchema.shape.body, taskIssue: noteUpdateSchema.shape.taskIssue,
}).strict().refine(value => ['title', 'body', 'taskIssue'].some(key => key in value), 'Supply at least one changed field');

function textResult<T extends Record<string, unknown>>(structuredContent: T, text: string) {
  return { content: [{ type: 'text' as const, text }], structuredContent };
}
function noteText(result: NoteResult, includeBody = false) {
  const { note } = result;
  const confirmation = `Note ${note.id} in ${result.projectId}, ${note.taskIssue === null ? 'General' : `task #${note.taskIssue}`}, ${note.status}, revision ${note.revision}.`;
  return includeBody ? `${confirmation}\n${note.title ? `${note.title}\n` : ''}${note.body}` : confirmation;
}
async function toolCall(operation: () => Promise<ReturnType<typeof textResult>>) {
  try { return await operation(); }
  catch (error) {
    if (!(error instanceof NotesApiError)) throw error;
    const structuredContent = { code: error.code, error: error.message,
      ...(error.currentNote ? { currentNote: error.currentNote } : {}),
      ...(error.clientRequestId ? { clientRequestId: error.clientRequestId } : {}) };
    const retry = error.clientRequestId ? `\nFor an uncertain creation, retry the same input with clientRequestId ${error.clientRequestId}.` : '';
    return { ...textResult(structuredContent, `${error.code}: ${error.message}${retry}`), isError: true };
  }
}
export function createNotesMcpServer(options: NotesMcpOptions) {
  const api = new NotesApiClient(options);
  const server = new McpServer({ name: 'mission-control-notes', version: '0.1.0' }, {
    capabilities: { tools: {} }, instructions: `Notes belong to ${api.projectId}. Task numbers are GitHub issue numbers. Use tasks_list to resolve task names. Omitted taskIssue creates a General note. Mission Control must be running. Use notes_get to read the latest revision before updating. Preserve host approval policy for writes.`,
  });
  server.registerTool('tasks_list', { description: 'List current board tasks, optionally searching issue number or title. These GitHub issue numbers are valid note links.',
    inputSchema: z.object({ search: searchSchema }).strict(), outputSchema: noteTasksResponseSchema, annotations: reads,
  }, ({ search }) => toolCall(async () => {
    const result = await api.tasks(); const query = search?.trim().toLowerCase();
    const tasks = query ? result.tasks.filter(task => `${task.issue} #${task.issue} ${task.title}`.toLowerCase().includes(query)) : result.tasks;
    return textResult({ ...result, tasks }, `${tasks.length} tasks in ${result.projectId}.\n${tasks.map(task => `#${task.issue} ${task.title}`).join('\n')}`);
  }));
  server.registerTool('notes_list', { description: 'List repository notes, active by default. scope all includes General and task notes; general means unlinked; task requires taskIssue. Search title, body, issue number or saved task title.',
    inputSchema: listSchema, outputSchema: notesSnapshotSchema, annotations: reads,
  }, input => toolCall(async () => {
    const result = await api.list(); const query = input.search?.trim().toLowerCase();
    const notes = result.notes.filter(note => (input.status === 'all' || note.status === input.status)
      && (input.scope === 'all' || (input.scope === 'general' ? note.taskIssue === null : note.taskIssue === input.taskIssue))
      && (!query || `${note.title ?? ''}\n${note.body}\n${note.taskIssue === null ? '' : `#${note.taskIssue}`} ${note.taskTitleAtLink ?? ''}`.toLowerCase().includes(query)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    return textResult({ ...result, notes }, `${notes.length} notes in ${result.projectId}.\n${notes.map(note => `${note.id}: ${note.title ?? note.body.split('\n').find(line => line.trim()) ?? ''} (${note.taskIssue === null ? 'General' : `#${note.taskIssue}`}, ${note.status}, revision ${note.revision})`).join('\n')}`);
  }));
  server.registerTool('notes_get', { description: 'Read the full note and latest revision before editing or changing its status.',
    inputSchema: z.object({ id: noteIdSchema }).strict(), outputSchema: noteResultSchema, annotations: reads,
  }, ({ id }) => toolCall(async () => { const result = await api.get(id); return textResult({ ...result }, noteText(result, true)); }));
  server.registerTool('notes_create', { description: 'Create a note. Omitted or null taskIssue means General; supplied numbers must be current GitHub issues on the board. Reuse clientRequestId and the same original input after an uncertain save.',
    inputSchema: createSchema, outputSchema: noteResultSchema, annotations: writes,
  }, input => toolCall(async () => { const result = await api.create(input); return textResult({ ...result }, noteText(result)); }));
  server.registerTool('notes_update', { description: 'Edit title, body, or task link with expectedRevision from notes_get. Omitted fields stay unchanged; null title or taskIssue clears that field. A new task link must be on the board.',
    inputSchema: updateSchema, outputSchema: noteResultSchema, annotations: { ...writes, destructiveHint: true },
  }, ({ id, ...input }) => toolCall(async () => { const result = await api.update(id, input); return textResult({ ...result }, noteText(result)); }));
  server.registerTool('notes_set_status', { description: 'Settle or reopen a note using its latest expectedRevision. This changes no task state. active reopens; settled keeps the note readable.',
    inputSchema: z.object({ id: noteIdSchema, expectedRevision: noteUpdateSchema.shape.expectedRevision, status: z.enum(['active', 'settled']) }).strict(), outputSchema: noteResultSchema, annotations: { ...writes, idempotentHint: true },
  }, ({ id, ...input }) => toolCall(async () => { const result = await api.update(id, input); return textResult({ ...result }, noteText(result)); }));
  return server;
}
export function runNotesMcp(options: NotesMcpOptions) {
  // Validate before waiting for a client's first message. serveStdio selects
  // modern or legacy negotiation and constructs one server for the connection.
  new NotesApiClient(options);
  return serveStdio(() => createNotesMcpServer(options), { onerror: error => console.error(error.message) });
}
