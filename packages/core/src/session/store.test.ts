import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Intervention } from '../schema/index.js';
import { UnknownInterventionError } from './broker-api.js';
import { createInterventionStore } from './store.js';

function makeIntervention(overrides: Partial<Intervention> = {}): Intervention {
  return {
    id: 'int_20260101_aaaaaaaa',
    runId: 'run_20260101_aaaaaaaa',
    runKind: 'replay',
    reason: { code: 'stuck', message: 'no locator matched' },
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'open',
    ...overrides,
  };
}

describe('createInterventionStore', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  function makeRoot(): string {
    root = mkdtempSync(path.join(tmpdir(), 'intervention-store-'));
    return root;
  }

  it('create/get/update round-trip and return independent deep copies', () => {
    const store = createInterventionStore();
    const record = makeIntervention();

    const created = store.create(record);
    expect(created).toEqual(record);

    // Mutating a returned record must never affect the store's own state.
    created.status = 'abandoned';
    expect(store.get(record.id)?.status).toBe('open');

    expect(store.get(record.id)).toEqual(record);
    expect(store.get('does-not-exist')).toBeUndefined();

    const updated = store.update(record.id, (current) => ({ ...current, status: 'resolved' }));
    expect(updated.status).toBe('resolved');
    expect(store.get(record.id)?.status).toBe('resolved');
  });

  it('list returns newest first and supports runId/status filters', () => {
    const store = createInterventionStore();
    const a = store.create(makeIntervention({ id: 'int_20260101_aaaaaaaa', runId: 'run_a', createdAt: '2026-01-01T00:00:00.000Z' }));
    const b = store.create(makeIntervention({ id: 'int_20260101_bbbbbbbb', runId: 'run_b', createdAt: '2026-01-02T00:00:00.000Z', status: 'resolved' }));

    expect(store.list().map((i) => i.id)).toEqual([b.id, a.id]);
    expect(store.list({ runId: 'run_a' }).map((i) => i.id)).toEqual([a.id]);
    expect(store.list({ status: 'resolved' }).map((i) => i.id)).toEqual([b.id]);
    expect(store.list({ runId: 'run_a', status: 'resolved' })).toEqual([]);
  });

  it('subscribe fires synchronously on create/update with the change kind; a throwing subscriber does not break the transition', () => {
    const store = createInterventionStore();
    const seen: Array<{ id: string; change: string }> = [];
    store.subscribe(() => {
      throw new Error('boom: a bad subscriber');
    });
    const unsubscribe = store.subscribe((i, change) => {
      seen.push({ id: i.id, change });
    });

    const record = makeIntervention();
    expect(() => store.create(record)).not.toThrow();
    expect(() => store.update(record.id, (c) => ({ ...c, status: 'resolved' }))).not.toThrow();

    expect(seen).toEqual([
      { id: record.id, change: 'created' },
      { id: record.id, change: 'updated' },
    ]);

    unsubscribe();
    store.update(record.id, (c) => ({ ...c, status: 'open' }));
    expect(seen).toHaveLength(2);
  });

  it('duplicate create throws and leaves the original record intact', () => {
    const store = createInterventionStore();
    const record = makeIntervention();
    store.create(record);
    expect(() => store.create(makeIntervention())).toThrow();
    expect(store.get(record.id)?.status).toBe('open');
  });

  it('update on an unknown id throws UnknownInterventionError', () => {
    const store = createInterventionStore();
    expect(() => store.update('int_nope_nope', (c) => c)).toThrow(UnknownInterventionError);
  });

  it('an invalid record throws on create and nothing is written to disk', () => {
    const rootDir = makeRoot();
    const store = createInterventionStore({ runDir: rootDir });
    const invalid = { ...makeIntervention(), status: 'not-a-real-status' } as unknown as Intervention;

    expect(() => store.create(invalid)).toThrow();
    expect(store.list()).toEqual([]);
    expect(existsSync(path.join(rootDir, 'interventions'))).toBe(false);
  });

  it('an invalid record throws on update and the previously persisted file is unchanged', () => {
    const rootDir = makeRoot();
    const store = createInterventionStore({ runDir: rootDir });
    const record = makeIntervention();
    store.create(record);

    expect(() => store.update(record.id, (c) => ({ ...c, status: 'not-a-real-status' as never }))).toThrow();
    expect(store.get(record.id)?.status).toBe('open');

    const onDisk = JSON.parse(readFileSync(path.join(rootDir, 'interventions', `${record.id}.json`), 'utf8')) as unknown;
    expect(Intervention.parse(onDisk).status).toBe('open');
  });

  it('persists schema-valid, redacted JSON at <runDir>/interventions/<id>.json on create and update', () => {
    const rootDir = makeRoot();
    const store = createInterventionStore({ runDir: rootDir });
    const record = makeIntervention({
      reason: { code: 'unrecoverable_condition', message: 'card on file 123-45-6789 failed validation' },
    });
    store.create(record);

    const filePath = path.join(rootDir, 'interventions', `${record.id}.json`);
    expect(existsSync(filePath)).toBe(true);

    const rawOnDisk = readFileSync(filePath, 'utf8');
    expect(rawOnDisk).not.toContain('123-45-6789');
    const parsedOnDisk = Intervention.parse(JSON.parse(rawOnDisk));
    expect(parsedOnDisk.reason.message).toContain('[REDACTED:ssn]');

    // Redaction is applied to the on-disk copy only -- the in-memory record keeps the raw value.
    expect(store.get(record.id)?.reason.message).toContain('123-45-6789');

    store.update(record.id, (c) => ({ ...c, status: 'abandoned' }));
    const rawAfterUpdate = readFileSync(filePath, 'utf8');
    expect(Intervention.parse(JSON.parse(rawAfterUpdate)).status).toBe('abandoned');
  });

  it('applies a custom redactor to the on-disk copy when provided', () => {
    const rootDir = makeRoot();
    const store = createInterventionStore({
      runDir: rootDir,
      redactor: (value) => JSON.parse(JSON.stringify(value).replace(/no locator matched/g, '[CUSTOM]')) as unknown,
    });
    const record = makeIntervention();
    store.create(record);

    const filePath = path.join(rootDir, 'interventions', `${record.id}.json`);
    const rawOnDisk = readFileSync(filePath, 'utf8');
    expect(rawOnDisk).toContain('[CUSTOM]');
    expect(rawOnDisk).not.toContain('no locator matched');
  });
});
