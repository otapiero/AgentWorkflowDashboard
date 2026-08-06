import { afterEach, describe, expect, test, vi } from 'vitest';

import { loadDocument, saveDocument } from '../src/web/doc-io.ts';

/** Record every request and reply with a canned JSON body. */
function stubFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadDocument', () => {
  test('reads the plan through the plan route and reports it as the real file', async () => {
    const calls = stubFetch({ content: '# plan\n' });
    const doc = await loadDocument(12, { kind: 'plan' });

    expect(calls[0]!.url).toBe('/api/tasks/12/plan');
    expect(doc).toEqual({
      content: '# plan\n',
      class: 'markdown',
      writeTarget: 'original',
      originalPath: '',
    });
  });

  test('reads an artifact through the artifact route, encoding the name', async () => {
    const calls = stubFetch({
      content: '# spec\n',
      class: 'markdown',
      writeTarget: 'original',
      originalPath: 'C:\\wt\\spec one.md',
    });
    const doc = await loadDocument(12, { kind: 'artifact', name: 'spec one.md' });

    expect(calls[0]!.url).toBe('/api/tasks/12/artifacts/spec%20one.md');
    expect(doc.writeTarget).toBe('original');
  });

  test('surfaces the server error message on failure', async () => {
    stubFetch({ error: 'artifact is not text', reason: 'binary' }, 415);
    await expect(loadDocument(12, { kind: 'artifact', name: 'shot.png' })).rejects.toThrow(
      'artifact is not text',
    );
  });
});

describe('saveDocument', () => {
  test('PUTs the plan and reports the real file', async () => {
    const calls = stubFetch({ ok: true });
    const target = await saveDocument(12, { kind: 'plan' }, 'new\n');

    expect(calls[0]).toMatchObject({ url: '/api/tasks/12/plan', method: 'PUT' });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ content: 'new\n' });
    expect(target).toBe('original');
  });

  test('PUTs an artifact and returns the target the server chose', async () => {
    const calls = stubFetch({ ok: true, writeTarget: 'snapshot' });
    const target = await saveDocument(12, { kind: 'artifact', name: 'spec.md' }, 'new\n');

    expect(calls[0]).toMatchObject({
      url: '/api/tasks/12/artifacts/spec.md',
      method: 'PUT',
    });
    expect(target).toBe('snapshot');
  });
});
