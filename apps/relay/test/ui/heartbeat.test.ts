/**
 * The UI's heartbeat loop (`src/ui/heartbeat.ts`) against a fake API and a real store, on fake
 * timers: a 409 or a 404 stops the loop until the store holds a new DTO for that intervention,
 * rather than restarting it on the next store notification.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeartbeatResponse, InterventionDto } from '../../src/shared/api.js';
import { ApiRequestError, type RelayApi } from '../../src/ui/api.js';
import type { AppContext } from '../../src/ui/context.js';
import { mountHeartbeat } from '../../src/ui/heartbeat.js';
import { createStore, pushToast, upsertIntervention, type RelayState, type ToastKind } from '../../src/ui/store.js';

const ID = 'int-1';

function mineDto(overrides: Partial<InterventionDto> = {}): InterventionDto {
  return {
    id: ID,
    runId: 'run-1',
    runKind: 'replay',
    capabilityId: 'lookup-member',
    reason: { code: 'unrecoverable_condition', message: 'stuck' },
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'human_active',
    heldBy: 'alice',
    hasScreenshot: false,
    humanActions: [],
    captureMode: 'none',
    timeline: [],
    ...overrides,
  };
}

function initial(dto: InterventionDto): RelayState {
  return {
    runs: {},
    interventions: { [dto.id]: dto },
    selectedId: null,
    connection: 'live',
    lastEventId: null,
    operator: 'alice',
    theme: 'system',
    shotMode: 'escalation',
    pending: {},
    toasts: [],
    clockSkewMs: 0,
  };
}

const OK: HeartbeatResponse = {
  interventionId: ID,
  at: '2026-01-01T00:00:05.000Z',
  lease: { ms: 60000, anchorAt: '2026-01-01T00:00:05.000Z', expiresAt: '2026-01-01T00:01:05.000Z' },
};

function setup(heartbeat: () => Promise<HeartbeatResponse>, intervention: () => Promise<InterventionDto>) {
  const store = createStore(initial(mineDto()));
  const toasts: { kind: ToastKind; message: string }[] = [];
  const api = {
    heartbeat: vi.fn(heartbeat),
    intervention: vi.fn(intervention),
  } as unknown as RelayApi & { heartbeat: ReturnType<typeof vi.fn>; intervention: ReturnType<typeof vi.fn> };
  const ctx: AppContext = {
    store,
    api,
    // Like the real app: a toast is a store change, so it triggers the loop's reconcile.
    toast: (kind, message) => {
      toasts.push({ kind, message });
      pushToast(store, kind, message);
    },
    confirm: () => Promise.resolve(false),
  };
  mountHeartbeat(ctx);
  return { store, api, toasts };
}

/** Lets pending promise callbacks and store notifications (microtasks) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('heartbeat loop', () => {
  it('renews every 5 s while the intervention is mine', async () => {
    const { api } = setup(() => Promise.resolve(OK), () => Promise.resolve(mineDto()));
    await settle();
    expect(api.heartbeat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.heartbeat).toHaveBeenCalledTimes(2);
  });

  it('a 409 stops the loop, toasts once and refetches once, even while the store still says mine; a new DTO restarts it', async () => {
    let refuse = true;
    const { store, api, toasts } = setup(
      () => (refuse ? Promise.reject(new ApiRequestError(409, 'conflict', 'not held', 'paused')) : Promise.resolve(OK)),
      // The server's copy still reads human_active/alice (e.g. SSE has not caught up): a fresh object, still "mine".
      () => Promise.resolve(mineDto()),
    );
    await settle();
    expect(api.heartbeat).toHaveBeenCalledTimes(1);
    expect(api.intervention).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.heartbeat).toHaveBeenCalledTimes(1);
    expect(api.intervention).toHaveBeenCalledTimes(1);
    expect(toasts.filter((t) => t.kind === 'error')).toHaveLength(1);

    // A later server update (a new DTO object) that still says mine starts the loop again.
    refuse = false;
    upsertIntervention(store, mineDto({ lastHeartbeatAt: '2026-01-01T00:00:40.000Z' }));
    await settle();
    expect(api.heartbeat).toHaveBeenCalledTimes(2);
  });

  it('a 404 is terminal: no retry, no refetch, one toast', async () => {
    const { api, toasts } = setup(
      () => Promise.reject(new ApiRequestError(404, 'not_found', 'unknown intervention')),
      () => Promise.resolve(mineDto()),
    );
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.heartbeat).toHaveBeenCalledTimes(1);
    expect(api.intervention).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.kind).toBe('error');
  });

  it('a network failure keeps retrying every 5 s with a single warning', async () => {
    const { api, toasts } = setup(
      () => Promise.reject(new ApiRequestError(0, 'network', 'unreachable')),
      () => Promise.resolve(mineDto()),
    );
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.heartbeat).toHaveBeenCalledTimes(3);
    expect(toasts).toEqual([{ kind: 'warning', message: "Can't reach Relay to renew your lease. Retrying." }]);
  });
});
