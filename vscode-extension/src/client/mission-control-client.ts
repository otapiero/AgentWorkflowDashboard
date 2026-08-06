import type { BoardConfig, HealthResponse, Phase, PollMeta, TaskWithDerived } from '../../../src/shared/types.ts';

import { parseSse } from './sse.ts';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiContractError';
  }
}

function parseHealthResponse(value: unknown): HealthResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiContractError('Invalid health response');
  }
  const health = value as Record<string, unknown>;
  if (
    health.status !== 'ok'
    || typeof health.apiVersion !== 'number'
    || !Number.isSafeInteger(health.apiVersion)
    || health.apiVersion <= 0
    || typeof health.serverVersion !== 'string'
    || typeof health.pid !== 'number'
    || !Number.isSafeInteger(health.pid)
    || health.pid <= 0
    || typeof health.startedAt !== 'string'
    || !(health.instanceId === null || health.instanceId === undefined || typeof health.instanceId === 'string')
  ) {
    throw new ApiContractError('Invalid health response');
  }
  return {
    status: 'ok',
    apiVersion: health.apiVersion,
    serverVersion: health.serverVersion,
    pid: health.pid,
    startedAt: health.startedAt,
    // Absent on a server predating the field; that reads as unclaimed, which is
    // the safe answer — we decline to own what we cannot identify.
    instanceId: typeof health.instanceId === 'string' && health.instanceId !== '' ? health.instanceId : null,
  };
}

export interface SpawnRequest {
  phase: Phase;
  customInstructions?: string;
  agent?: string;
  model?: string;
  effort?: string;
}

export interface SseHandlers {
  onOpen(): void | Promise<void>;
  onTasks(tasks: TaskWithDerived[]): void | Promise<void>;
  onPoll(meta: PollMeta): void;
  onClosed(error: Error | null): void;
}

export class MissionControlClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly fetchImpl: typeof fetch = globalThis.fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  health(signal: AbortSignal): Promise<HealthResponse> {
    return this.request('/api/health', signal, {}, parseHealthResponse);
  }

  config(signal: AbortSignal): Promise<BoardConfig> {
    return this.request('/api/config', signal);
  }

  tasks(signal: AbortSignal): Promise<TaskWithDerived[]> {
    return this.request('/api/tasks', signal);
  }

  reconcile(signal: AbortSignal): Promise<TaskWithDerived[]> {
    return this.request('/api/reconcile', signal, { method: 'POST' });
  }

  spawn(issue: number, request: SpawnRequest, signal: AbortSignal): Promise<{ spawned: unknown }> {
    return this.request(`/api/tasks/${issue}/spawn`, signal, {
      method: 'POST',
      body: request,
    });
  }

  async connect(handlers: SseHandlers, signal: AbortSignal): Promise<void> {
    let closedError: Error | null = null;

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/events?replay=0`, {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
        signal,
      });
      if (!response.ok) throw await this.errorFrom(response);
      if (!response.body) throw new Error('SSE response has no body');

      await handlers.onOpen();
      for await (const event of parseSse(response.body, signal)) {
        if (event.event === 'tasks') {
          await handlers.onTasks(JSON.parse(event.data) as TaskWithDerived[]);
        } else if (event.event === 'poll') {
          handlers.onPoll(JSON.parse(event.data) as PollMeta);
        }
      }
    } catch (error) {
      closedError = signal.aborted
        ? null
        : error instanceof Error ? error : new Error(String(error));
    } finally {
      handlers.onClosed(closedError);
    }
  }

  private async request<T>(
    path: string,
    signal: AbortSignal,
    init: { method?: 'GET' | 'POST'; body?: unknown } = {},
    parse?: (value: unknown) => T,
  ): Promise<T> {
    const method = init.method ?? 'GET';
    const headers: Record<string, string> = { Accept: 'application/json' };
    const request: RequestInit = { method, headers, signal };
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      request.body = JSON.stringify(init.body);
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, request);
    if (!response.ok) throw await this.errorFrom(response);
    let value: unknown;
    try {
      value = await response.json();
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      if (parse) throw new ApiContractError('Invalid health response');
      throw error;
    }
    return parse ? parse(value) : value as T;
  }

  private async errorFrom(response: Response): Promise<ApiError> {
    let message = `Request failed with status ${response.status}`;
    try {
      const body = await response.json() as { error?: unknown };
      if (typeof body.error === 'string') message = body.error;
    } catch {
      // Server errors may not have a JSON body; the HTTP status remains useful.
    }
    return new ApiError(response.status, message);
  }
}
