import { expect, test } from 'vitest';

import { parseSse } from '../../src/client/sse.ts';

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

test('parses split CRLF frames and joins multiline data', async () => {
  const events = [];
  for await (const event of parseSse(
    stream(['event: tasks\r\ndata: [{"issue":', '1}]\r\ndata: tail\r\n\r\n']),
    new AbortController().signal,
  )) {
    events.push(event);
  }

  expect(events).toEqual([{ event: 'tasks', data: '[{"issue":1}]\ntail' }]);
});

test('normalizes CRLF pairs split across transport chunks', async () => {
  const events = [];
  for await (const event of parseSse(
    stream(['event: tasks\r', '\ndata: ready\r', '\n\r', '\n']),
    new AbortController().signal,
  )) {
    events.push(event);
  }

  expect(events).toEqual([{ event: 'tasks', data: 'ready' }]);
});

test('accepts a large chunk containing many complete small frames', async () => {
  const frame = 'event: ping\ndata: x\n\n';
  const frames = 50_000;
  let received = 0;

  for await (const event of parseSse(stream([frame.repeat(frames)]), new AbortController().signal)) {
    expect(event).toEqual({ event: 'ping', data: 'x' });
    received += 1;
  }

  expect(received).toBe(frames);
});
