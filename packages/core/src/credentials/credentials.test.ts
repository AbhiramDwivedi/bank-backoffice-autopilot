/**
 * The credential port's own rules: `credentialSet` semantics, the env provider, and
 * `loadCredentials` (name validation, de-duplication, the `missing` rule, a throwing provider).
 */
import { describe, expect, it } from 'vitest';
import { ValueBinding } from '../schema/index.js';
import { CREDENTIAL_NAME_RE, credentialSet, envCredentialProvider, loadCredentials, EMPTY_CREDENTIALS, type CredentialProvider } from './index.js';

describe('credentialSet', () => {
  it('drops empty and undefined values, so get never returns "" and values() never holds one', () => {
    const set = credentialSet({ A: 'x1', B: '', C: undefined });
    expect(set.get('A')).toBe('x1');
    expect(set.get('B')).toBeUndefined();
    expect(set.get('C')).toBeUndefined();
    expect(set.values()).toEqual(['x1']);
    expect(set.names()).toEqual(['A']);
  });

  it('copies its input: a later mutation changes nothing', () => {
    const src: Record<string, string> = { A: 'one' };
    const set = credentialSet(src);
    src.A = 'two';
    expect(set.get('A')).toBe('one');
    expect(Object.isFrozen(set)).toBe(true);
  });

  it('accepts a Map', () => {
    expect(credentialSet(new Map([['A', 'v']])).get('A')).toBe('v');
  });
});

describe('envCredentialProvider', () => {
  it('reads only the requested names from the env it was given', async () => {
    const r = await envCredentialProvider({ A: 'a-val', B: 'b-val', OTHER: 'o' }).load(['A', 'B']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.set.get('A')).toBe('a-val');
    expect(r.set.get('OTHER')).toBeUndefined();
  });

  it('has the id "env"', () => {
    expect(envCredentialProvider({}).id).toBe('env');
  });
});

describe('loadCredentials', () => {
  it('returns the empty set without calling the provider when no names are requested', async () => {
    let called = false;
    const p: CredentialProvider = {
      id: 'spy',
      load: () => {
        called = true;
        return Promise.resolve({ ok: true, set: EMPTY_CREDENTIALS });
      },
    };
    const r = await loadCredentials(p, []);
    expect(r).toEqual({ ok: true, set: EMPTY_CREDENTIALS });
    expect(called).toBe(false);
  });

  it('de-duplicates names before asking the provider', async () => {
    let asked: readonly string[] = [];
    const p: CredentialProvider = {
      id: 'spy',
      load: (names) => {
        asked = names;
        return Promise.resolve({ ok: true, set: credentialSet({ A: 'v' }) });
      },
    };
    await loadCredentials(p, ['A', 'A']);
    expect(asked).toEqual(['A']);
  });

  it('names exactly the missing credentials and the provider, and no value', async () => {
    const r = await loadCredentials(envCredentialProvider({ MOCK_USER: 'operator-x', MOCK_PASSWORD: '' }), ['MOCK_USER', 'MOCK_PASSWORD', 'API_TOKEN']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ code: 'missing', providerId: 'env', names: ['MOCK_PASSWORD', 'API_TOKEN'] });
    expect(r.error.message).toContain('MOCK_PASSWORD');
    expect(JSON.stringify(r)).not.toContain('operator-x');
  });

  it('rejects an invalid credential name before calling the provider', async () => {
    const r = await loadCredentials(envCredentialProvider({}), ['lower_case', 'OK']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid_name');
    expect(r.error.names).toEqual(['lower_case']);
  });

  it('keeps only the requested names when a provider returns more', async () => {
    const p: CredentialProvider = { id: 'chatty', load: () => Promise.resolve({ ok: true, set: credentialSet({ A: 'a', EXTRA: 'extra-secret' }) }) };
    const r = await loadCredentials(p, ['A']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.set.values()).toEqual(['a']);
    expect(r.set.get('EXTRA')).toBeUndefined();
  });

  it('reports a throwing provider as provider_error without its message (which could quote a value)', async () => {
    const p: CredentialProvider = {
      id: 'broken',
      load: () => Promise.reject(new TypeError('could not parse "hunter2-value"')),
    };
    const r = await loadCredentials(p, ['A']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('provider_error');
    expect(r.error.message).toContain('TypeError');
    expect(JSON.stringify(r)).not.toContain('hunter2');
  });

  it('passes a provider failure through unchanged', async () => {
    const p: CredentialProvider = {
      id: 'down',
      load: () => Promise.resolve({ ok: false, error: { code: 'unavailable', providerId: 'down', names: ['A'], message: 'source not reachable' } }),
    };
    const r = await loadCredentials(p, ['A']);
    expect(r).toEqual({ ok: false, error: { code: 'unavailable', providerId: 'down', names: ['A'], message: 'source not reachable' } });
  });
});

describe('CREDENTIAL_NAME_RE', () => {
  it('matches the names the schema accepts in a secret binding', () => {
    for (const name of ['MOCK_USER', '_X', 'A1', '1A', 'a', 'A-B', '']) {
      const schemaAccepts = ValueBinding.safeParse({ kind: 'secret', env: name }).success;
      expect(CREDENTIAL_NAME_RE.test(name), name).toBe(schemaAccepts);
    }
  });
});
