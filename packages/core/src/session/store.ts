/**
 * In-memory intervention store, optionally mirrored to `<runDir>/interventions/<id>.json`.
 *
 * Design: docs/design/handoff.md ("Preserve context and evidence" / "File layout"). Every
 * record is validated against the `Intervention` zod schema on the way in (both `create` and
 * `update`); an invalid record is rejected before anything is mutated or written. Callers get
 * back (and this store keeps) deep copies (`structuredClone`), so mutating a returned record can
 * never corrupt the store's own state, and mutating the store's state can never leak back out
 * through a previously-returned reference.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Intervention, type InterventionStatus } from '../schema/index.js';
import { createRedactor } from '../evidence/index.js';
import { UnknownInterventionError } from './broker-api.js';
import type { InterventionChange, InterventionStore, InterventionStoreOptions } from './broker-api.js';

/**
 * Creates an in-memory intervention store. When `opts.runDir` is set, every create/update also
 * writes a redacted JSON copy to `<runDir>/interventions/<id>.json`. Throws when a record fails
 * schema validation; nothing is mutated or written on that path.
 */
export function createInterventionStore(opts: InterventionStoreOptions = {}): InterventionStore {
  const records = new Map<string, Intervention>();
  const subscribers = new Set<(i: Intervention, change: InterventionChange) => void>();
  const redactor = opts.redactor ?? createRedactor();
  const interventionsDir = opts.runDir !== undefined ? path.join(opts.runDir, 'interventions') : undefined;

  function persist(record: Intervention): void {
    if (interventionsDir === undefined) return;
    mkdirSync(interventionsDir, { recursive: true });
    const redacted = redactor(record);
    writeFileSync(path.join(interventionsDir, `${record.id}.json`), JSON.stringify(redacted, null, 2), 'utf8');
  }

  function notify(record: Intervention, change: InterventionChange): void {
    for (const cb of subscribers) {
      try {
        cb(structuredClone(record), change);
      } catch {
        // A bad subscriber must not break the transition that triggered it.
      }
    }
  }

  function create(i: Intervention): Intervention {
    const parsed = Intervention.parse(i);
    if (records.has(parsed.id)) {
      throw new Error(`InterventionStore: an intervention with id '${parsed.id}' already exists`);
    }
    const copy = structuredClone(parsed);
    records.set(copy.id, copy);
    persist(copy);
    notify(copy, 'created');
    return structuredClone(copy);
  }

  function get(id: string): Intervention | undefined {
    const record = records.get(id);
    return record === undefined ? undefined : structuredClone(record);
  }

  function update(id: string, fn: (current: Intervention) => Intervention): Intervention {
    const current = records.get(id);
    if (current === undefined) throw new UnknownInterventionError(id);
    const next = fn(structuredClone(current));
    const parsed = Intervention.parse(next);
    const copy = structuredClone(parsed);
    records.set(id, copy);
    persist(copy);
    notify(copy, 'updated');
    return structuredClone(copy);
  }

  function list(filter?: { runId?: string; status?: InterventionStatus }): Intervention[] {
    const filtered = Array.from(records.values()).filter(
      (r) => (filter?.runId === undefined || r.runId === filter.runId) && (filter?.status === undefined || r.status === filter.status),
    );
    filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return filtered.map((r) => structuredClone(r));
  }

  function subscribe(cb: (i: Intervention, change: InterventionChange) => void): () => void {
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  }

  return { create, get, update, list, subscribe };
}
