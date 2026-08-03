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
