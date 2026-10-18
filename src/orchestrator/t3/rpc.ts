import { randomUUID } from 'node:crypto';
import { T3_TIMEOUT_MS } from './paths.ts';

/** One Effect JSON RPC call. Never retry a mutation after an uncertain reply. */
export function callT3Rpc(url: URL, method: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const id = randomUUID();
    let finished = false;
    const finish = (error?: Error, value?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('T3 RPC timed out; check the thread in T3 before retrying the launch.')), T3_TIMEOUT_MS);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ _tag: 'Request', id, tag: method, payload, headers: [] }));
    });
    socket.addEventListener('error', () => finish(new Error('T3 RPC connection failed; check the thread in T3 before retrying the launch.')));
    socket.addEventListener('close', () => finish(new Error('T3 RPC connection closed before confirming the launch; check the thread in T3 before retrying.')));
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message._tag === 'Ping') {
          socket.send(JSON.stringify({ _tag: 'Pong' }));
          return;
        }
        if (message._tag !== 'Exit' || message.requestId !== id) return;
        if (message.exit?._tag === 'Success') finish(undefined, message.exit.value);
        else finish(new Error(`T3 rejected the launch: ${rpcFailureMessage(message.exit?.cause)}`));
      } catch {
        finish(new Error('T3 RPC returned an unsupported response; check API compatibility.'));
      }
    });
  });
}

function rpcFailureMessage(cause: unknown): string {
  if (Array.isArray(cause)) return cause.map(rpcFailureMessage).join('; ');
  if (typeof cause === 'string') return cause;
  if (typeof cause === 'object' && cause !== null) {
    const value = cause as Record<string, unknown>;
    if (value.error) return rpcFailureMessage(value.error);
    if (value.defect) return rpcFailureMessage(value.defect);
    const message = typeof value.message === 'string' ? value.message : '';
    const nested = value.cause ? rpcFailureMessage(value.cause) : '';
    if (message && nested && message !== nested) return `${message}: ${nested}`;
    if (message || nested) return message || nested;
  }
  return 'Unknown RPC failure';
}
