/**
 * `--credentials` / `CU_CREDENTIALS` spec parsing: the three forms, and errors that never echo the
 * argument text.
 */
import { describe, expect, it } from 'vitest';
import { parseCredentialSpec } from './spec.js';

describe('parseCredentialSpec', () => {
  it('env -> the env provider', () => {
    const r = parseCredentialSpec('env');
    expect(r.ok && r.provider.id).toBe('env');
  });

  it('file:<path> keeps a Windows drive colon in the path', () => {
    const r = parseCredentialSpec('file:C:\\secrets\\creds.json');
    expect(r.ok && r.provider.id).toBe('file:C:\\secrets\\creds.json');
  });

  it('exec:<command> ids the program only, never the arguments', () => {
    const r = parseCredentialSpec('exec:vault-helper --token s.SuperSecretToken --path kv/app');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.provider.id).toBe('exec:vault-helper');
    expect(r.provider.id).not.toContain('SuperSecretToken');
  });

  it('rejects empty file:/exec:, a bad exec command line, and unknown kinds without echoing arguments', () => {
    expect(parseCredentialSpec('file:').ok).toBe(false);
    expect(parseCredentialSpec('exec:   ').ok).toBe(false);
    const unterminated = parseCredentialSpec('exec:helper "s3cret');
    expect(unterminated.ok).toBe(false);
    if (!unterminated.ok) expect(unterminated.message).not.toContain('s3cret');
    const unknown = parseCredentialSpec('vault:kv/app?token=s3cret');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.message).toContain('env | file:<path> | exec:<command>');
      expect(unknown.message).not.toContain('s3cret');
      expect(unknown.message).not.toContain('vault');
    }
    const pastedToken = parseCredentialSpec('ghp_PastedTokenNoColon123');
    expect(pastedToken.ok).toBe(false);
    if (!pastedToken.ok) {
      expect(pastedToken.message).not.toContain('PastedToken');
    }
  });
});
