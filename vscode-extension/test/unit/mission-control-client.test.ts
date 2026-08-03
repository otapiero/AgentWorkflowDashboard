import { EventEmitter } from 'node:events';

import { expect, test, vi } from 'vitest';

import { Broadcaster } from '../../../src/server/sse.ts';
import { ApiContractError, ApiError, MissionControlClient } from '../../src/client/mission-control-client.ts';
import { config, task } from './fixtures.ts';

const validHealth = {
  status: 'ok',
  apiVersion: 1,
  serverVersion: '1.0.0',
  pid: 42,
  startedAt: '2026-08-03T10:00:00.000Z',
} as const;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function eventStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

test('uses the normalized origin, JSON headers, and caller signal for REST requests', async () => {
  const fetchMock = vi.fn<typeof fetch>();
  const signal = new AbortController().signal;
  fetchMock
    .mockResolvedValueOnce(response({ status: 'ok', apiVersion: 1, serverVersion: '1.0.0', pid: 1, startedAt: '2026-08-03T10:00:00.000Z' }))
    .mockResolvedValueOnce(response(config))
    .mockResolvedValueOnce(response([task()]))
    .mockResolvedValueOnce(response({ spawned: { pid: 42 } }))
    .mockResolvedValueOnce(response([task()]));
  const client = new MissionControlClient('http://127.0.0.1:4317/', fetchMock);

  await expect(client.health(signal)).resolves.toMatchObject({ status: 'ok' });
  await expect(client.config(signal)).resolves.toEqual(config);
  await expect(client.tasks(signal)).resolves.toEqual([task()]);
  await expect(client.spawn(3060, { phase: 'implement', customInstructions: 'Ship it' }, signal)).resolves.toEqual({ spawned: { pid: 42 } });
  await expect(client.reconcile(signal)).resolves.toEqual([task()]);

  expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:4317/api/health', expect.objectContaining({ method: 'GET', headers: { Accept: 'application/json' }, signal }));
  expect(fetchMock).toHaveBeenNthCalledWith(4, 'http://127.0.0.1:4317/api/tasks/3060/spawn', expect.objectContaining({ method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ phase: 'implement', customInstructions: 'Ship it' }), signal }));
  expect(fetchMock).toHaveBeenNthCalledWith(5, 'http://127.0.0.1:4317/api/reconcile', expect.objectContaining({ method: 'POST', signal }));
});

test('health returns a complete validated response and tolerates additive fields', async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response({ ...validHealth, futureField: 'allowed' }));
  const client = new MissionControlClient('http://127.0.0.1:4317', fetchMock);

  await expect(client.health(new AbortController().signal)).resolves.toEqual(validHealth);
});

test('health rejects malformed JSON with a payload-free contract error', async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{not-json', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  const client = new MissionControlClient('http://127.0.0.1:4317', fetchMock);

  await expect(client.health(new AbortController().signal)).rejects.toEqual(new ApiContractError('Invalid health response'));
});

test('health preserves AbortError while a resolved response body is pending', async () => {
  const controller = new AbortController();
  let bodyController!: ReadableStreamDefaultController<Uint8Array>;
  const pendingBody = new ReadableStream<Uint8Array>({
    start(value) { bodyController = value; },
  });
  controller.signal.addEventListener('abort', () => {
    bodyController.error(new DOMException('The operation was aborted.', 'AbortError'));
  }, { once: true });
  const response = new Response(pendingBody, { status: 200, headers: { 'content-type': 'application/json' } });
  const json = vi.spyOn(response, 'json');
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  const client = new MissionControlClient('http://127.0.0.1:4317', fetchMock);

  const health = client.health(controller.signal);
  await vi.waitFor(() => expect(json).toHaveBeenCalledOnce());
  controller.abort();
  const error: unknown = await health.catch((reason: unknown) => reason);

  expect(error).toMatchObject({ name: 'AbortError' });
  expect(error).not.toBeInstanceOf(ApiContractError);
});

test.each([
  ['null', null],
  ['array', []],
  ['missing field', { status: 'ok', apiVersion: 1, serverVersion: '1.0.0', pid: 42 }],
  ['wrong status', { ...validHealth, status: 'starting' }],
  ['string API version', { ...validHealth, apiVersion: '1' }],
  ['non-positive API version', { ...validHealth, apiVersion: 0 }],
  ['fractional API version', { ...validHealth, apiVersion: 1.5 }],
  ['wrong server version', { ...validHealth, serverVersion: 1 }],
  ['non-positive PID', { ...validHealth, pid: 0 }],
  ['fractional PID', { ...validHealth, pid: 42.5 }],
  ['wrong start time', { ...validHealth, startedAt: 1 }],
])('health rejects %s response data', async (_name, body) => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(body));
  const client = new MissionControlClient('http://127.0.0.1:4317', fetchMock);

  await expect(client.health(new AbortController().signal)).rejects.toEqual(new ApiContractError('Invalid health response'));
});

test('throws ApiError with the server error message', async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response({ error: 'task not on the board' }, 404));
  const client = new MissionControlClient('http://127.0.0.1:4317', fetchMock);

  await expect(client.tasks(new AbortController().signal)).rejects.toEqual(new ApiError(404, 'task not on the board'));
});

test('connect dispatches known events and reports a normal close once', async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(eventStream([
    `event: tasks\ndata: ${JSON.stringify([task()])}\n\n`,
    'event: poll\ndata: {"checkedAt":"2026-08-03T10:00:00.000Z","rateLimit":null}\n\n',
    'event: ignored\ndata: {"secret":"do not parse"}\n\n',
  ]), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  const onOpen = vi.fn();
  const onTasks = vi.fn();
  const onPoll = vi.fn();
  const onClosed = vi.fn();
  const client = new MissionControlClient('http://127.0.0.1:4317', fetchMock);

  await client.connect({ onOpen, onTasks, onPoll, onClosed }, new AbortController().signal);

  expect(onOpen).toHaveBeenCalledOnce();
  expect(onTasks).toHaveBeenCalledWith([task()]);
  expect(onPoll).toHaveBeenCalledWith({ checkedAt: '2026-08-03T10:00:00.000Z', rateLimit: null });
  expect(onClosed).toHaveBeenCalledExactlyOnceWith(null);
  expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4317/api/events?replay=0', expect.objectContaining({ headers: { Accept: 'text/event-stream' } }));
});

test('replay-disabled stream applies an in-flight transition only after the authoritative baseline', async () => {
  const cached = task({ phase: 'plan' });
  const baseline = task({ phase: 'implement' });
  const transitioned = task({ phase: 'ci' });
  const broadcaster = new Broadcaster();
  broadcaster.send('tasks', [cached]);
  const encoder = new TextEncoder();
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      const raw = new EventEmitter() as EventEmitter & { write(chunk: string): boolean };
      raw.write = (chunk) => { controller.enqueue(encoder.encode(chunk)); return true; };
      const replay = new URL(String(input)).searchParams.get('replay') !== '0';
      (broadcaster.add as unknown as (reply: never, options: { replay: boolean }) => void)({ raw } as never, { replay });
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  let releaseBaseline!: () => void;
  let baselineStarted!: () => void;
  const started = new Promise<void>((resolve) => { baselineStarted = resolve; });
  const waitForBaseline = new Promise<void>((resolve) => { releaseBaseline = resolve; });
  const order: string[] = [];
  const notifications: string[] = [];
  let currentPhase = cached.derived.displayPhase;
  const client = new MissionControlClient('http://127.0.0.1:4317', fetchMock);

  const connected = client.connect({
    onOpen: async () => {
      order.push('reconcile:start');
      baselineStarted();
      await waitForBaseline;
      currentPhase = baseline.derived.displayPhase;
      order.push(`baseline:${currentPhase}`);
    },
    onTasks: async ([next]) => {
      notifications.push(`${currentPhase}->${next!.derived.displayPhase}`);
      currentPhase = next!.derived.displayPhase;
      order.push(`sse:${currentPhase}`);
    },
    onPoll: vi.fn(),
    onClosed: vi.fn(),
  }, new AbortController().signal);
  await started;
  broadcaster.send('tasks', [transitioned]);
  streamController.close();
  releaseBaseline();
  await connected;

  expect(order).toEqual(['reconcile:start', 'baseline:implement', 'sse:ci']);
  expect(notifications).toEqual(['implement->ci']);
});

test('connect stops after aborting the stream and reports closed once', async () => {
  const controller = new AbortController();
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({
    start() {},
    cancel() {},
  }), { status: 200 }));
  const onOpen = vi.fn();
  const onClosed = vi.fn();
  const client = new MissionControlClient('http://127.0.0.1:4317', fetchMock);

  const connected = client.connect({ onOpen, onTasks: vi.fn(), onPoll: vi.fn(), onClosed }, controller.signal);
  await vi.waitFor(() => expect(onOpen).toHaveBeenCalledOnce());
  controller.abort();
  await connected;

  expect(onClosed).toHaveBeenCalledExactlyOnceWith(null);
});

test('connect treats an abort before the event response as a normal close', async () => {
  const controller = new AbortController();
  const fetchMock = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
  }));
  const onOpen = vi.fn();
  const onClosed = vi.fn();
  const client = new MissionControlClient('http://127.0.0.1:4317', fetchMock);

  const connected = client.connect({ onOpen, onTasks: vi.fn(), onPoll: vi.fn(), onClosed }, controller.signal);
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  controller.abort();
  await connected;

  expect(onOpen).not.toHaveBeenCalled();
  expect(onClosed).toHaveBeenCalledExactlyOnceWith(null);
});
