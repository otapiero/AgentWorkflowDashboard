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

      buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
      if (buffer.length > MAX_BUFFER_CHARS) {
        throw new Error('SSE frame exceeds maximum size');
      }
      let boundary = buffer.indexOf('\n\n');

      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = frame.split('\n').filter((line) => !line.startsWith(':'));
        const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
        const data = lines
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');

        if (data) yield { event, data };
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    signal.removeEventListener('abort', cancelReader);
    await reader.cancel().catch(() => undefined);
  }
}
