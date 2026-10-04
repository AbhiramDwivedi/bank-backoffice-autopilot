/**
 * Red team: screen masking must not blind the irreversible-action guardrail. A control whose text
 * is masked ("Delete Pat Example" repeats a masked member name) is still classified on its real
 * text by the enforcing surface, while the decision event quotes only the masked view.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY_PATH, loadPolicy } from './load.js';
import { createPolicyGuard } from './guard.js';
import { withPolicy, type PolicyDecisionEvent } from './enforcing-surface.js';
import { FakeSurface } from '../surface/fake/surface.js';
import { el, scenario } from '../surface/fake/scenario.js';

function surface(): FakeSurface {
  return new FakeSurface(
    scenario()
      .screen('detail', {
        url: 'http://localhost:4173/members/7',
        title: 'Member',
        elements: [
          el({ id: 'name', role: 'cell', name: 'Pat Example', text: 'Pat Example', tag: 'td', bbox: { x: 0, y: 0, w: 10, h: 10 }, masked: 'member_name' }),
          el({ id: 'del', role: 'button', name: 'Delete Pat Example', text: 'Delete Pat Example', tag: 'button', bbox: { x: 0, y: 20, w: 10, h: 10 }, masked: 'member_name' }),
        ],
      })
      .on('click', { targetId: 'del' })
      .goto('detail')
      .build(),
  );
}

describe('masking does not blind the irreversible guardrail', () => {
  it('a masked "Delete ..." button is refused as irreversible without approval, and the event never quotes its real text', async () => {
    const events: PolicyDecisionEvent[] = [];
    const policy = loadPolicy(DEFAULT_POLICY_PATH);
    const guarded = withPolicy(surface(), createPolicyGuard(policy), { runKind: 'discovery', onDecision: (e) => events.push(e) });
    const obs = await guarded.observe();
    const del = obs.elements.find((e) => e.role === 'button')!;
    expect(del.name).toBe('[MASKED:member_name]');

    const refused = await guarded.act({ type: 'click', target: { ref: del.ref } }, 1000);
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe('policy_violation');
    expect(JSON.stringify(events)).not.toContain('Pat Example');

    const allowed = await guarded.act({ type: 'click', target: { ref: del.ref } }, 1000, { allowIrreversible: true });
    expect(allowed.ok).toBe(true);
  });
});
