/**
 * Seeded chaos: intermittent, reproducible faults for one mock-app instance.
 *
 * The explicit switches in faults.ts are all-or-nothing: `failSearch: true` fails every search.
 * Chaos makes the same faults fire with a probability per request, drawn from a seeded PRNG, so a
 * `replay --times N` series faces the kind of trouble a real legacy app produces (a search that
 * fails now and then, a maintenance popup that sometimes shows up mid-flow) and still produces the
 * same faults on every re-run with the same seed.
 *
 * Decisions worth knowing before changing this file:
 *
 * - **PRNG: mulberry32.** 32 bits of state, one multiply-xorshift round per draw, no
 *   dependencies, and good enough statistical quality for fault injection (it is not a
 *   cryptographic generator and must never be used as one).
 * - **One independent stream per fault kind.** Each kind's stream is seeded with
 *   `fmix32(seed XOR fnv1a(kind))`, so the kinds never share a sequence: adding a kind, or one kind
 *   drawing more often (an extra search), never shifts the numbers another kind draws. (A fault
 *   can still change which requests happen next, and so which request gets a draw.)
 *   `streamSeed` is exported so the test can pin this.
 * - **Draws happen only on transaction routes** (`/members/...`), never on the shell frames,
 *   static assets or login. The workstation loads three frames in parallel and Chromium decides
 *   their order; drawing on them would hand the same random number to a different request from
 *   one run to the next. The member routes load one at a time in the `main` frame, so the draw
 *   sequence follows the replay's own step order.
 * - **The config object's identity is the restart signal.** `ctx.faults.chaos` holds the
 *   validated config; `chaosRuntime(ctx)` (context.ts) rebuilds the streams, counters and log
 *   whenever that object is not the one the runtime was built from. Every accepted
 *   `POST /__faults {"chaos": {...}}` stores a fresh object, so it always restarts the sequence
 *   from the seed, even with an identical config; `/__reset` and `{"chaos": null}` drop it.
 * - **Validation is all-or-nothing for the chaos object.** One bad sub-key rejects the whole
 *   object (reported as `chaos.<key>`) and leaves the previous chaos state untouched, so a typo
 *   can never leave half a chaos config running.
 */

/** The fault kinds chaos can inject. Each has its own PRNG stream. */
export const CHAOS_KINDS = ['failSearch', 'slowMs', 'interstitial', 'expireSession'] as const;
/** One of {@link CHAOS_KINDS}. */
export type ChaosKind = (typeof CHAOS_KINDS)[number];

/** Upper bound on a chaos delay: a 2-minute stall is already far past any replay step timeout. */
export const CHAOS_MAX_DELAY_MS = 120_000;
/** The chaos log keeps the most recent entries only; older ones are counted in `logDropped`. */
export const CHAOS_LOG_LIMIT = 1000;

/** Probability-and-range shape for an intermittent slow response. */
export interface ChaosSlow {
  /** Probability in [0, 1] that a transaction request is delayed. */
  p: number;
  /** Inclusive lower bound of the delay, in ms. */
  minMs: number;
  /** Inclusive upper bound of the delay, in ms (>= minMs, <= {@link CHAOS_MAX_DELAY_MS}). */
  maxMs: number;
}

/**
 * Validated chaos configuration, as set through `POST /__faults {"chaos": {...}}` and returned by
 * `GET /__faults`. Omitted kinds never draw.
 */
export interface ChaosConfig {
  /** Unsigned 32-bit integer seed. */
  seed: number;
  /** Probability that a `GET /members/search` returns the 500 Application Error page. */
  failSearch?: number;
  /** Probability that a transaction request is delayed by a random amount in [minMs, maxMs]. */
  slowMs?: ChaosSlow;
  /** Probability that a main-content page shows the maintenance notice (beyond the once-per-session one). */
  interstitial?: number;
  /** Probability that an authenticated transaction request expires the session. */
  expireSession?: number;
}

/** Per-kind counters: how many times the kind drew a number, and how many draws injected the fault. */
export interface ChaosKindStats {
  draws: number;
  fired: number;
}

/** One injected fault, in the order the app injected them. No session ids, cookies, or query strings. */
export interface ChaosLogEntry {
  /** 1-based position among all injected faults since chaos (re)started. */
  seq: number;
  kind: ChaosKind;
  /** 1-based index of the draw, within this kind's own stream, that fired. */
  draw: number;
  method: string;
  /** Request path only (no query string). */
  path: string;
  /** The injected delay, for `slowMs`. */
  delayMs?: number;
}

/** Live chaos state for one app instance: the config it was built from, the streams, counters and log. */
export interface ChaosRuntime {
  readonly config: ChaosConfig;
  readonly streams: Partial<Record<ChaosKind, () => number>>;
  readonly stats: Partial<Record<ChaosKind, ChaosKindStats>>;
  readonly log: ChaosLogEntry[];
  logDropped: number;
  injected: number;
}

/** What `GET /__faults/chaos` returns. */
export interface ChaosReport {
  config: ChaosConfig | null;
  stats: Partial<Record<ChaosKind, ChaosKindStats>>;
  log: ChaosLogEntry[];
  logDropped: number;
}

// ---------------------------------------------------------------------------------------------
// PRNG
// ---------------------------------------------------------------------------------------------

/** mulberry32: returns a generator of uniform floats in [0, 1) from a 32-bit seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit FNV-1a hash of an ASCII string. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** MurmurHash3's 32-bit finalizer: spreads every input bit over the whole output. */
function fmix32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The seed of `kind`'s own stream under the run seed `seed`. Depends on nothing but the two. */
export function streamSeed(seed: number, kind: string): number {
  return fmix32((seed >>> 0) ^ fnv1a(kind));
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isProbability(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

function isDelay(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= CHAOS_MAX_DELAY_MS;
}

/** Result of {@link parseChaos}: the validated config (null = chaos off), or every rejected key. */
export type ParsedChaos = { ok: true; config: ChaosConfig | null } | { ok: false; rejected: string[] };

/**
 * Validates the `chaos` value of a `POST /__faults` body. `null` turns chaos off. Anything else must
 * be an object with an unsigned 32-bit integer `seed` and only known kinds, each well-formed;
 * every problem is reported (as `chaos`, `chaos.<key>` or `chaos.slowMs.<field>`), never ignored.
 */
export function parseChaos(value: unknown): ParsedChaos {
  if (value === null) return { ok: true, config: null };
  if (!isPlainObject(value)) return { ok: false, rejected: ['chaos (expected an object or null)'] };

  const rejected: string[] = [];
  const config: ChaosConfig = { seed: 0 };

  if (!('seed' in value)) rejected.push('chaos.seed (required)');

  for (const [k, v] of Object.entries(value)) {
    switch (k) {
      case 'seed':
        if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff) config.seed = v;
        else rejected.push('chaos.seed');
        break;
      case 'failSearch':
      case 'interstitial':
      case 'expireSession':
        if (isProbability(v)) config[k] = v;
        else rejected.push(`chaos.${k}`);
        break;
      case 'slowMs': {
        if (!isPlainObject(v)) {
          rejected.push('chaos.slowMs (expected {p, minMs, maxMs})');
          break;
        }
        const before = rejected.length;
        for (const sub of Object.keys(v)) {
          if (sub !== 'p' && sub !== 'minMs' && sub !== 'maxMs') rejected.push(`chaos.slowMs.${sub}`);
        }
        if (!isProbability(v.p)) rejected.push('chaos.slowMs.p');
        if (!isDelay(v.minMs)) rejected.push('chaos.slowMs.minMs');
        if (!isDelay(v.maxMs)) rejected.push('chaos.slowMs.maxMs');
        else if (isDelay(v.minMs) && v.maxMs < v.minMs) rejected.push('chaos.slowMs.maxMs (must be >= minMs)');
        if (rejected.length === before) config.slowMs = { p: v.p as number, minMs: v.minMs as number, maxMs: v.maxMs as number };
        break;
      }
      default:
        rejected.push(`chaos.${k}`);
    }
  }

  return rejected.length > 0 ? { ok: false, rejected } : { ok: true, config };
}

// ---------------------------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------------------------

/** Fresh streams, zeroed counters and an empty log for `config`. Only configured kinds get a stream. */
export function createChaosRuntime(config: ChaosConfig): ChaosRuntime {
  const streams: Partial<Record<ChaosKind, () => number>> = {};
  const stats: Partial<Record<ChaosKind, ChaosKindStats>> = {};
  for (const kind of CHAOS_KINDS) {
    if (config[kind] === undefined) continue;
    streams[kind] = mulberry32(streamSeed(config.seed, kind));
    stats[kind] = { draws: 0, fired: 0 };
  }
  return { config, streams, stats, log: [], logDropped: 0, injected: 0 };
}

/** Where a draw happened, for the chaos log. */
export interface DrawSite {
  method: string;
  path: string;
}

function record(rt: ChaosRuntime, kind: ChaosKind, draw: number, site: DrawSite, delayMs?: number): void {
  rt.injected += 1;
  rt.log.push({ seq: rt.injected, kind, draw, method: site.method, path: site.path, ...(delayMs !== undefined ? { delayMs } : {}) });
  if (rt.log.length > CHAOS_LOG_LIMIT) {
    rt.log.shift();
    rt.logDropped += 1;
  }
}

/**
 * Draws once from `kind`'s stream and reports whether the fault fires. A kind that is not
 * configured never draws and never fires. Use {@link drawDelay} for `slowMs`.
 */
export function drawFault(rt: ChaosRuntime | null, kind: Exclude<ChaosKind, 'slowMs'>, site: DrawSite): boolean {
  const next = rt?.streams[kind];
  const p = rt?.config[kind];
  if (!rt || !next || p === undefined) return false;
  const stats = rt.stats[kind]!;
  stats.draws += 1;
  const fired = next() < p;
  if (fired) {
    stats.fired += 1;
    record(rt, kind, stats.draws, site);
  }
  return fired;
}

/**
 * Draws from the `slowMs` stream: one number for "does this request stall", and, only when it
 * does, a second for how long (uniform integer in [minMs, maxMs]). Returns the delay, 0 = none.
 */
export function drawDelay(rt: ChaosRuntime | null, site: DrawSite): number {
  const next = rt?.streams.slowMs;
  const slow = rt?.config.slowMs;
  if (!rt || !next || !slow) return 0;
  const stats = rt.stats.slowMs!;
  stats.draws += 1;
  if (!(next() < slow.p)) return 0;
  const delayMs = slow.minMs + Math.floor(next() * (slow.maxMs - slow.minMs + 1));
  // A 0 ms delay (possible with minMs 0) injects nothing: a draw, but not a fired fault or a log entry.
  if (delayMs === 0) return 0;
  stats.fired += 1;
  record(rt, 'slowMs', stats.draws, site, delayMs);
  return delayMs;
}

/** The `GET /__faults/chaos` body for a runtime (or for chaos off). Copies, so callers cannot mutate live state. */
export function chaosReport(rt: ChaosRuntime | null): ChaosReport {
  if (!rt) return { config: null, stats: {}, log: [], logDropped: 0 };
  const stats: Partial<Record<ChaosKind, ChaosKindStats>> = {};
  for (const [k, v] of Object.entries(rt.stats) as [ChaosKind, ChaosKindStats][]) stats[k] = { ...v };
  return { config: structuredClone(rt.config), stats, log: rt.log.map((e) => ({ ...e })), logDropped: rt.logDropped };
}
