export interface SseEvent {
  event: string;
  data: string;
}

const MAX_BUFFER_CHARS = 1_000_000;

export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const cancelReader = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', cancelReader, { once: true });

  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replaceAll('\r\n', '\n');
      let start = 0;
      let boundary = buffer.indexOf('\n\n', start);

      while (boundary >= 0) {
        if (signal.aborted) {
          buffer = '';
          return;
        }
        const frame = buffer.slice(start, boundary);
        start = boundary + 2;
        const lines = frame.split('\n').filter((line) => !line.startsWith(':'));
        const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
        const data = lines
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');

        if (data) yield { event, data };
        boundary = buffer.indexOf('\n\n', start);
      }

      buffer = buffer.slice(start);
      if (buffer.length > MAX_BUFFER_CHARS) {
        throw new Error('SSE frame exceeds maximum size');
      }
    }
  } finally {
    signal.removeEventListener('abort', cancelReader);
    await reader.cancel().catch(() => undefined);
  }
}
