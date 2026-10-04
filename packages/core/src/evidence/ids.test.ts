import { describe, expect, it } from 'vitest';
import { INTERVENTION_ID_RE, newInterventionId, newRunId, RUN_ID_RE } from './ids.js';

describe('ids', () => {
  it('newRunId matches RUN_ID_RE and embeds the UTC date', () => {
    const fixed = new Date('2026-01-05T23:59:59.000Z');
    const id = newRunId(fixed);
    expect(id).toMatch(RUN_ID_RE);
    expect(id.startsWith('run_20260105_')).toBe(true);
  });

  it('newInterventionId matches INTERVENTION_ID_RE and embeds the UTC date', () => {
    const fixed = new Date('2026-12-31T00:00:00.000Z');
    const id = newInterventionId(fixed);
    expect(id).toMatch(INTERVENTION_ID_RE);
    expect(id.startsWith('int_20261231_')).toBe(true);
  });

  it('uses UTC, not local time, for the date component', () => {
    // A time that is late-in-the-day UTC would roll to the next local day in a positive
    // timezone offset, and vice versa; asserting against toISOString keeps this independent
    // of the machine's local timezone.
    const fixed = new Date('2026-06-15T08:30:00.000Z');
    const runId = newRunId(fixed);
    const isoDatePart = fixed.toISOString().slice(0, 10).replace(/-/g, '');
    expect(runId).toBe(runId); // sanity: no throw
    expect(runId.split('_')[1]).toBe(isoDatePart);
  });

  it('defaults `now` to the current time when omitted', () => {
    const before = new Date();
    const id = newRunId();
    const after = new Date();
    const datePart = id.split('_')[1] ?? '';
    const beforeDate = before.toISOString().slice(0, 10).replace(/-/g, '');
    const afterDate = after.toISOString().slice(0, 10).replace(/-/g, '');
    expect([beforeDate, afterDate]).toContain(datePart);
  });

  it('generates distinct ids on repeated calls', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newRunId()));
    expect(ids.size).toBe(50);
  });

  it('nanoid suffix is lowercase alphanumeric, 8 chars', () => {
    const id = newRunId();
    const suffix = id.split('_')[2] ?? '';
    expect(suffix).toMatch(/^[0-9a-z]{8}$/);
  });
});
