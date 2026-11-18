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

test('joins multiline data when CRLF pairs and payloads cross transport chunks', async () => {
  const events = [];
  for await (const event of parseSse(
    stream(['event: tasks\r', '\ndata: [{"issue":', '1}]\r', '\ndata: tail\r', '\n\r', '\n']),
    new AbortController().signal,
  )) {
    events.push(event);
  }

  expect(events).toEqual([{ event: 'tasks', data: '[{"issue":1}]\ntail' }]);
});

test('accepts a large chunk containing many complete small frames', async () => {
  const frame = 'event: ping\ndata: x\n\n';
  const frames = 50_000;
  let received = 0;
  let last: string | undefined;

  const chunk = frame.repeat(frames) + 'event: ping\ndata: end\n\n';
  for await (const event of parseSse(stream([chunk]), new AbortController().signal)) {
    received += 1;
    last = event.data;
  }

  expect(received).toBe(frames + 1);
  expect(last).toBe('end');
});

test('stops draining buffered frames after the consumer aborts', async () => {
  const controller = new AbortController();
  const events = [];

  for await (const event of parseSse(
    stream(['event: tasks\ndata: first\n\nevent: tasks\ndata: later\n\n']),
    controller.signal,
  )) {
    events.push(event);
    controller.abort();
  }

  expect(events).toEqual([{ event: 'tasks', data: 'first' }]);
});
