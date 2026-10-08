import { afterEach, describe, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NoteCard } from '../src/web/components/notes/NoteCard.tsx';
import type { Note } from '../src/shared/notes.ts';

const createdAt = '2026-10-01T10:00:00Z';
const day = 86_400_000;
const note: Note = {
  id: 'note', title: 'Reminder', body: 'Follow up', taskIssue: null, taskTitleAtLink: null,
  status: 'active', createdAt, updatedAt: createdAt, settledAt: null, revision: 1, clientRequestId: 'request',
};
function render(age: number, changes: Partial<Note> = {}) {
  vi.setSystemTime(Date.parse(createdAt) + age);
  return renderToStaticMarkup(createElement(NoteCard, {
    note: { ...note, ...changes }, tasks: [], repoUrl: 'https://github.com/acme/app',
    onOpen: () => {}, onOpenTask: () => {}, onStatus: () => {}, busy: false, disabled: false,
  }));
}
afterEach(() => vi.useRealTimers());

describe('unsettled note age indicators', () => {
  test.each([0, 2 * day - 1])('no warning before two complete days, age %s', age => {
    expect(render(age)).not.toContain('notes-age');
  });
  test.each([2 * day, 3 * day - 1])('one amber warning between two and three days, age %s', age => {
    const html = render(age);
    expect(html).toContain('notes-age is-warning');
    expect(html.match(/class="notes-age-icon"/g)).toHaveLength(1);
    expect(html).toMatch(/role="img" aria-label="[^"]*2 days[^"]*"/);
  });
  test.each([
    [3 * day, 1], [4 * day - 1, 1], [4 * day, 2], [5 * day, 3],
    [6 * day, 4], [7 * day, 5], [30 * day, 5],
  ])('red indicators after %s milliseconds, count %s', (age, count) => {
    const html = render(age);
    expect(html).toContain('notes-age is-overdue');
    expect(html.match(/class="notes-age-icon"/g)).toHaveLength(count);
    expect(html).not.toContain('notes-age is-warning');
  });
  test('editing does not clear the age warning', () => {
    expect(render(5 * day, { updatedAt: '2026-10-06T09:59:59Z' }).match(/class="notes-age-icon"/g)).toHaveLength(3);
  });
  test('settled notes have no age warning', () => {
    expect(render(30 * day, { status: 'settled', settledAt: '2026-10-02T10:00:00Z' })).not.toContain('notes-age');
  });
  test('a future creation timestamp does not show a warning', () => {
    expect(render(-day)).not.toContain('notes-age');
  });
});
