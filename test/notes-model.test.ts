import { describe, expect, test } from 'vitest';
import type { Note } from '../src/shared/notes.ts';
import { selectNotes, noteCounts, taskChoices, newDraft, saveDraft, loadDraft, validateDraft, notesProjectId } from '../src/web/notes-model.ts';

export function note(id: string, extra: Partial<Note> = {}): Note {
  return { id, title: null, body: 'Remember this', taskIssue: null, taskTitleAtLink: null,
    status: 'active', createdAt: '2026-10-06T10:00:00Z', updatedAt: '2026-10-06T10:00:00Z',
    settledAt: null, revision: 1, clientRequestId: '11111111-1111-4111-8111-111111111111', ...extra };
}
const tasks = [{ issue: 42, title: 'Deployment retry' }];
test('repository identity matches server normalization for dot-prefixed repositories', () => expect(notesProjectId('ACME', '.github')).toBe('acme__github'));
describe('note selection', () => {
  const notes = [note('general'), note('linked', { taskIssue: 42 })];
  test('general excludes linked notes', () => expect(selectNotes(notes, tasks, { kind: 'general' }, '').active.map(n => n.id)).toEqual(['general']));
  test('task excludes other scopes', () => expect(selectNotes(notes, tasks, { kind: 'task', issue: 42 }, '').active.map(n => n.id)).toEqual(['linked']));
  test.each(['deployment', '#42', '42'])('search includes linked task text %s', query => expect(selectNotes(notes, tasks, { kind: 'all' }, query).active.map(n => n.id)).toEqual(['linked']));
  test('search retains forgotten task titles', () => expect(selectNotes([note('old', { taskIssue: 9, taskTitleAtLink: 'Rollback' })], [], { kind: 'all' }, 'rollback').active).toHaveLength(1));
  test('sorts active by update then stable ID and settled by settlement', () => {
    const result = selectNotes([note('b'), note('a'), note('new', { updatedAt: '2026-10-07T00:00:00Z' }), note('s1', { status: 'settled', settledAt: '2026-10-05' }), note('s2', { status: 'settled', settledAt: '2026-10-06' })], [], { kind: 'all' }, '');
    expect(result.active.map(n => n.id)).toEqual(['new', 'a', 'b']); expect(result.settled.map(n => n.id)).toEqual(['s2', 's1']);
  });
  test('counts active notes independent of search', () => expect(noteCounts([...notes, note('settled', { status: 'settled' })])).toEqual({ all: 2, general: 1, tasks: { 42: 1 } }));
  test('filter choices retain removed tasks and prefer current titles', () => expect(taskChoices([note('old', { taskIssue: 9, taskTitleAtLink: 'Gone' }), note('linked', { taskIssue: 42, taskTitleAtLink: 'Old' })], tasks)).toEqual([{ issue: 9, title: 'Gone', retained: true }, { issue: 42, title: 'Deployment retry', retained: false }]));
});
describe('drafts', () => {
  const entries = new Map<string, string>();
  const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
  test('new draft retains request ID and exact text through reload', () => {
    const draft = { ...newDraft(null), body: '  שלום\ntext  ' };
    saveDraft(storage, 'acme__app', draft);
    expect(loadDraft(storage, 'acme__app', 'new')).toEqual(draft);
    expect(loadDraft(storage, 'other', 'new')).toBeNull();
    expect(draft.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
  });
  test('uncertain creation retains its original payload and retry state on reload', () => {
    saveDraft(storage, 'acme__app', { ...newDraft(42), clientRequestId: '11111111-1111-4111-8111-111111111111', title: 'Retry', body: '  Keep exactly\n', uncertainCreate: true });
    expect(loadDraft(storage, 'acme__app', 'new')).toMatchObject({ clientRequestId: '11111111-1111-4111-8111-111111111111', title: 'Retry', body: '  Keep exactly\n', taskIssue: 42, uncertainCreate: true });
  });
  test('invalid storage and storage failure do not crash', () => {
    entries.set('mc-notes-draft:acme:new', '{broken');
    expect(loadDraft(storage, 'acme', 'new')).toBeNull();
    expect(saveDraft({ ...storage, setItem: () => { throw new Error('quota'); } }, 'acme', newDraft(null))).toBe(false);
  });
  test('validates whitespace body and UTF-8 byte length', () => {
    expect(validateDraft({ ...newDraft(null), body: '   ' }).body).toBeTruthy();
    expect(validateDraft({ ...newDraft(null), body: 'א'.repeat(32769) }).body).toBeTruthy();
    expect(validateDraft({ ...newDraft(null), title: 'a'.repeat(241), body: 'ok' }).title).toBeTruthy();
    expect(validateDraft({ ...newDraft(null), body: '  ok\n' })).toEqual({});
  });
});
