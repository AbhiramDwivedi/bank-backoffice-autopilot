/**
 * Typed HTTP client for the Relay API. Every call has a timeout, sends JSON, and turns a non-2xx
 * response into an `ApiRequestError` carrying the server's `{error: {code, message, state}}`.
 */
import type {
  ApiError,
  HeartbeatResponse,
  InterventionDto,
  InterventionsResponse,
  ResolutionResponse,
  ResumeFrom,
  RunsResponse,
} from '../shared/api.js';

const TIMEOUT_MS = 10_000;

export class ApiRequestError extends Error {
  override readonly name = 'ApiRequestError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Control state that refused the call (409 only). */
    readonly state?: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal }): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const onAbort = (): void => ctrl.abort();
  init?.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(path, {
      method: init?.method ?? 'GET',
      headers: init?.body !== undefined ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: ctrl.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const err = (body as ApiError | undefined)?.error;
      throw new ApiRequestError(res.status, err?.code ?? 'internal', err?.message ?? `Request failed (${res.status})`, err?.state);
    }
    return body as T;
  } catch (err) {
    if (err instanceof ApiRequestError) throw err;
    if (ctrl.signal.aborted) throw new ApiRequestError(0, 'timeout', 'Relay did not answer in time. Check that the run is still up.');
    throw new ApiRequestError(0, 'network', 'Relay is unreachable. Check that the run is still up.');
  } finally {
    clearTimeout(timer);
    init?.signal?.removeEventListener('abort', onAbort);
  }
}

const enc = encodeURIComponent;

export interface RelayApi {
  runs(): Promise<RunsResponse>;
  interventions(): Promise<InterventionsResponse>;
  intervention(id: string): Promise<InterventionDto>;
  take(id: string, by: string): Promise<InterventionDto>;
  handBack(id: string, input: { by: string; resumeFrom: ResumeFrom; notes?: string }): Promise<ResolutionResponse>;
  abort(id: string, by: string, notes?: string): Promise<ResolutionResponse>;
  heartbeat(id: string, by: string): Promise<HeartbeatResponse>;
  /**
   * Fetches the run's live screenshot (server-throttled to one capture per second). Returns an
   * object URL the caller must revoke with `URL.revokeObjectURL` once replaced, and the capture
   * time from the `X-Relay-Captured-At` header.
   */
  liveScreenshot(runId: string, signal?: AbortSignal): Promise<{ objectUrl: string; capturedAt: string }>;
  /** URL of the escalation screenshot (static; safe to put in `img.src`). */
  escalationScreenshotUrl(id: string): string;
}

export function createApi(): RelayApi {
  return {
    runs: () => request<RunsResponse>('/api/runs'),
    interventions: () => request<InterventionsResponse>('/api/interventions'),
    intervention: (id) => request<InterventionDto>(`/api/interventions/${enc(id)}`),
    take: (id, by) => request<InterventionDto>(`/api/interventions/${enc(id)}/take`, { method: 'POST', body: { by } }),
    handBack: (id, input) =>
      request<ResolutionResponse>(`/api/interventions/${enc(id)}/handback`, {
        method: 'POST',
        body: { by: input.by, resumeFrom: input.resumeFrom, ...(input.notes ? { notes: input.notes } : {}) },
      }),
    abort: (id, by, notes) =>
      request<ResolutionResponse>(`/api/interventions/${enc(id)}/abort`, { method: 'POST', body: { by, ...(notes ? { notes } : {}) } }),
    heartbeat: (id, by) => request<HeartbeatResponse>(`/api/interventions/${enc(id)}/heartbeat`, { method: 'POST', body: { by } }),
    async liveScreenshot(runId, signal) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const onAbort = (): void => ctrl.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await fetch(`/api/runs/${enc(runId)}/screenshot`, { signal: ctrl.signal, cache: 'no-store', credentials: 'same-origin' });
        if (!res.ok) {
          const body = (await res.json().catch(() => undefined)) as ApiError | undefined;
          throw new ApiRequestError(res.status, body?.error.code ?? 'internal', body?.error.message ?? `Live view failed (${res.status})`);
        }
        const blob = await res.blob();
        return { objectUrl: URL.createObjectURL(blob), capturedAt: res.headers.get('X-Relay-Captured-At') ?? new Date().toISOString() };
      } catch (err) {
        if (err instanceof ApiRequestError) throw err;
        throw new ApiRequestError(0, ctrl.signal.aborted ? 'timeout' : 'network', 'Live view is unavailable right now.');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    },
    escalationScreenshotUrl: (id) => `/api/interventions/${enc(id)}/screenshot`,
  };
}
