/**
 * The act pane (#act): what the operator can do about the selected intervention, entirely driven
 * by its viewState. Each viewState gets its own small panel builder; the panel is only rebuilt
 * when the selected id or its viewState changes, so the hand-back form's radio choice and notes
 * survive an SSE update (a heartbeat renewing the lease, say) that merely replaces the dto.
 */
import type { InterventionDto, ResumeFrom, RunDto } from '../../shared/api.js';
import { ApiRequestError } from '../api.js';
import type { AppContext } from '../context.js';
import { byId, h, setAttr, setChildren, setText } from '../dom.js';
import { formatClock, formatCountdown, titleOf } from '../format.js';
import { continuedWithLabel, HANDED_BACK_TEXT, nextStepHelp, repeatsCopy, retryOptionCopy, retryResumeOf } from '../labels.js';
import {
  leaseRemainingMs,
  selected,
  serverNow,
  setPending,
  upsertIntervention,
  viewState,
  type PendingOp,
  type ViewState,
} from '../store.js';
import { buildCapturedActions, updateCapturedActions } from './actions-list.js';
import { onTick } from './ticker.js';

interface ActPanel {
  root: HTMLElement;
  update(dto: InterventionDto, pendingOp: PendingOp | undefined): void;
}

export function mountAct(ctx: AppContext): void {
  const asideEl = byId('act');

  let mounted: { key: string; vs: ViewState; panel: ActPanel } | undefined;
  let prevDto: InterventionDto | undefined;
  let prevRun: RunDto | undefined;
  let prevOperator: string | undefined;
  let prevPendingOp: PendingOp | undefined;
  let prevSelectedId: string | null | undefined;

  function render(): void {
    const state = ctx.store.get();
    const dto = selected(state);
    const run = dto ? state.runs[dto.runId] : undefined;
    const pendingOp = dto ? state.pending[dto.id] : undefined;

    if (
      dto === prevDto &&
      run === prevRun &&
      state.operator === prevOperator &&
      pendingOp === prevPendingOp &&
      state.selectedId === prevSelectedId
    ) {
      return;
    }
    prevDto = dto;
    prevRun = run;
    prevOperator = state.operator;
    prevPendingOp = pendingOp;
    prevSelectedId = state.selectedId;

    if (!dto) {
      mounted = undefined;
      setChildren(asideEl, buildNoSelection());
      return;
    }

    const vs = viewState(dto, run, state.operator);
    const key = `${dto.id}:${vs}`;
    if (!mounted || mounted.key !== key) {
      const panel = buildPanel(ctx, vs, dto);
      mounted = { key, vs, panel };
      setChildren(asideEl, panel.root);
    }
    mounted.panel.update(dto, pendingOp);
  }

  ctx.store.subscribe(render);
  render();

  onTick(() => {
    if (!mounted || mounted.vs !== 'mine') return;
    const state = ctx.store.get();
    const dto = selected(state);
    if (!dto) return;
    mounted.panel.update(dto, state.pending[dto.id]);
  });
}

function buildNoSelection(): HTMLElement {
  return h('p', { class: 'meta act-empty' }, 'Select an intervention to act on it.');
}

function buildPanel(ctx: AppContext, vs: ViewState, dto: InterventionDto): ActPanel {
  switch (vs) {
    case 'paused':
      return buildPausedPanel(ctx, dto);
    case 'mine':
      return buildMinePanel(ctx, dto);
    case 'held':
      return buildHeldPanel(ctx, dto);
    case 'resuming':
      return buildResumingPanel(dto);
    case 'resolved':
    case 'abandoned':
      return buildResolutionPanel(vs, dto);
  }
}

// ---- Commands --------------------------------------------------------------------------------

function reportApiError(ctx: AppContext, err: unknown): void {
  if (err instanceof ApiRequestError && err.status === 409) {
    ctx.toast('error', `Relay refused this: ${err.message}`);
    return;
  }
  ctx.toast('error', err instanceof Error ? err.message : String(err));
}

async function runTake(ctx: AppContext, id: string): Promise<void> {
  setPending(ctx.store, id, 'take');
  try {
    const dto = await ctx.api.take(id, ctx.store.get().operator);
    upsertIntervention(ctx.store, dto);
    ctx.toast('success', 'Control taken');
  } catch (err) {
    reportApiError(ctx, err);
  } finally {
    setPending(ctx.store, id, null);
  }
}

async function runHandBack(ctx: AppContext, id: string, resumeFrom: ResumeFrom, notes: string, resetForm: () => void): Promise<void> {
  setPending(ctx.store, id, 'handback');
  try {
    await ctx.api.handBack(id, { by: ctx.store.get().operator, resumeFrom, ...(notes ? { notes } : {}) });
    ctx.toast('success', HANDED_BACK_TEXT);
    resetForm();
  } catch (err) {
    reportApiError(ctx, err);
  } finally {
    setPending(ctx.store, id, null);
  }
}

async function runAbort(ctx: AppContext, id: string): Promise<void> {
  const ok = await ctx.confirm({
    title: 'Abort this run?',
    body: 'Automation stops and the run ends as abandoned. This cannot be undone.',
    confirmLabel: 'Abort run',
  });
  if (!ok) return;
  setPending(ctx.store, id, 'abort');
  try {
    await ctx.api.abort(id, ctx.store.get().operator);
    ctx.toast('success', 'Run aborted');
  } catch (err) {
    reportApiError(ctx, err);
  } finally {
    setPending(ctx.store, id, null);
  }
}

// ---- Panels ------------------------------------------------------------------------------------

function buildPausedPanel(ctx: AppContext, dto: InterventionDto): ActPanel {
  const id = dto.id;
  const takeBtn = h(
    'button',
    { id: 'take-control', type: 'button', class: 'btn btn-primary btn-lg', onclick: () => void runTake(ctx, id) },
    'Take control',
  );
  const note = h('p', { class: 'meta' }, 'Automation stays paused while you work in the live browser.');
  const abortBtn = h(
    'button',
    { id: 'abort', type: 'button', class: 'btn btn-danger-quiet', onclick: () => void runAbort(ctx, id) },
    'Abort run',
  );
  const root = h('div', { class: 'act-panel act-paused' }, takeBtn, note, abortBtn);
  return {
    root,
    update(_current, pendingOp) {
      const takeBusy = pendingOp === 'take';
      setAttr(takeBtn, 'aria-busy', takeBusy ? 'true' : false);
      takeBtn.disabled = takeBusy;
      const abortBusy = pendingOp === 'abort';
      setAttr(abortBtn, 'aria-busy', abortBusy ? 'true' : false);
      abortBtn.disabled = abortBusy;
    },
  };
}

function buildMinePanel(ctx: AppContext, dto: InterventionDto): ActPanel {
  const id = dto.id;
  const sessionLabelEl = h('strong', null, dto.sessionLabel ?? 'the automation browser');
  const instruction = h(
    'p',
    { id: 'instruction' },
    'You have control. Work in the Chromium window titled “',
    sessionLabelEl,
    '”. Hand back when done.',
  );

  const leaseValueEl = h('span', { class: 'lease-value mono num' });
  const leaseBarEl = h('div', { class: 'lease-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-label': 'Lease remaining' });
  const leaseBlockEl = h(
    'div',
    { id: 'lease', class: 'lease-block' },
    h('span', { class: 'label' }, 'Lease'),
    leaseValueEl,
    leaseBarEl,
  );

  const capturedEl = buildCapturedActions(dto);

  // What "retry" will do is fixed for this round (automation set it when it escalated), so the
  // copy is built once with the panel. After a lost session a retry is not a retry of this step.
  const retryHint = retryResumeOf(dto);
  const site = { hasStep: dto.stepId !== undefined };
  const retryCopy = retryOptionCopy(retryHint, site);
  const nextHelp = nextStepHelp(retryHint, site);
  const repeats = repeatsCopy(retryHint);
  const radioCurrent = h('input', {
    type: 'radio',
    id: 'resume-current',
    name: 'resumeFrom',
    value: 'current_step',
    checked: true,
    ...(retryCopy.help !== undefined ? { 'aria-describedby': 'resume-current-help' } : {}),
  });
  const radioNext = h('input', {
    type: 'radio',
    id: 'resume-next',
    name: 'resumeFrom',
    value: 'next_step',
    ...(nextHelp !== undefined ? { 'aria-describedby': 'resume-next-help' } : {}),
  });
  const notesField = h('textarea', { id: 'handback-notes', name: 'notes', maxlength: 4000, rows: 3 });
  const submitBtn = h('button', { id: 'handback-submit', type: 'submit', class: 'btn btn-primary btn-lg' }, 'Hand back');

  function resetForm(): void {
    notesField.value = '';
    radioCurrent.checked = true;
    radioNext.checked = false;
  }

  function submit(): void {
    if (ctx.store.get().pending[id] !== undefined) return;
    const resumeFrom: ResumeFrom = radioNext.checked ? 'next_step' : 'current_step';
    void runHandBack(ctx, id, resumeFrom, notesField.value.trim(), resetForm);
  }

  const form = h(
    'form',
    {
      id: 'handback',
      onsubmit: (ev: Event) => {
        ev.preventDefault();
        submit();
      },
    },
    h(
      'fieldset',
      null,
      h('legend', null, 'How should automation continue?'),
      h('label', { class: 'radio-option', id: 'resume-current-label' }, radioCurrent, retryCopy.label),
      retryCopy.help !== undefined ? h('p', { class: 'meta radio-help', id: 'resume-current-help' }, retryCopy.help) : null,
      repeats !== undefined
        ? h(
            'div',
            { class: 'meta radio-help', id: 'resume-current-repeats' },
            h('p', { class: 'radio-help-intro' }, repeats.intro),
            h('ul', null, ...repeats.steps.map((st) => h('li', null, st))),
          )
        : null,
      h('label', { class: 'radio-option' }, radioNext, 'I completed this step, continue'),
      nextHelp !== undefined ? h('p', { class: 'meta radio-help', id: 'resume-next-help' }, nextHelp) : null,
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'handback-notes' }, 'Notes for the audit trail'), notesField),
      submitBtn,
    ),
  );

  const abortBtn = h(
    'button',
    { id: 'abort', type: 'button', class: 'btn btn-danger-quiet', onclick: () => void runAbort(ctx, id) },
    'Abort run',
  );

  const root = h(
    'div',
    { class: 'act-panel act-mine' },
    instruction,
    leaseBlockEl,
    capturedEl,
    form,
    h('hr', { class: 'hairline' }),
    abortBtn,
  );

  let warned = false;

  return {
    root,
    update(current, pendingOp) {
      setText(sessionLabelEl, current.sessionLabel ?? 'the automation browser');

      if (current.lease) {
        const remaining = leaseRemainingMs(current, serverNow(ctx.store.get())) ?? 0;
        const clamped = Math.max(0, remaining);
        const isLow = remaining <= 120_000;
        setText(leaseValueEl, isLow ? `Expires in ${formatCountdown(remaining)}` : formatCountdown(remaining));
        setAttr(leaseBarEl, 'aria-valuemax', String(current.lease.ms));
        setAttr(leaseBarEl, 'aria-valuenow', String(clamped));
        setAttr(leaseBarEl, 'data-remaining-ms', String(clamped));
        setAttr(leaseBlockEl, 'data-remaining-ms', String(clamped));
        leaseBarEl.style.setProperty('--lease-fraction', String(Math.min(1, clamped / current.lease.ms)));
        setAttr(leaseBlockEl, 'data-low', isLow ? 'true' : false);
        if (isLow && remaining > 0 && !warned) {
          warned = true;
          ctx.toast('warning', `Your lease on ${titleOf(current)} expires in under a minute. Keep Relay open to renew it.`);
        }
      }

      updateCapturedActions(capturedEl, current);

      const handbackBusy = pendingOp === 'handback';
      setAttr(submitBtn, 'aria-busy', handbackBusy ? 'true' : false);
      // submit() ignores a hand-back while any operation on this intervention is in flight. That
      // includes the take itself: its SSE update can switch this panel to 'mine' before the take's
      // own response lands, so the button stays disabled until then instead of eating the click.
      submitBtn.disabled = pendingOp !== undefined;
      notesField.disabled = handbackBusy;
      radioCurrent.disabled = handbackBusy;
      radioNext.disabled = handbackBusy;

      const abortBusy = pendingOp === 'abort';
      setAttr(abortBtn, 'aria-busy', abortBusy ? 'true' : false);
      abortBtn.disabled = abortBusy;
    },
  };
}

function buildHeldPanel(ctx: AppContext, dto: InterventionDto): ActPanel {
  const id = dto.id;
  const textEl = h('p', null, holderLine(dto));
  const capturedEl = buildCapturedActions(dto);
  const abortBtn = h(
    'button',
    { id: 'abort', type: 'button', class: 'btn btn-danger-quiet', onclick: () => void runAbort(ctx, id) },
    'Abort run',
  );
  const root = h('div', { class: 'act-panel act-held' }, textEl, capturedEl, abortBtn);
  return {
    root,
    update(current, pendingOp) {
      setText(textEl, holderLine(current));
      updateCapturedActions(capturedEl, current);
      const abortBusy = pendingOp === 'abort';
      setAttr(abortBtn, 'aria-busy', abortBusy ? 'true' : false);
      abortBtn.disabled = abortBusy;
    },
  };
}

function holderLine(dto: InterventionDto): string {
  return `${dto.heldBy ?? 'Another operator'} has control. You can act after they hand back.`;
}

function buildResumingPanel(dto: InterventionDto): ActPanel {
  const textEl = h('p', null, HANDED_BACK_TEXT);
  const capturedEl = buildCapturedActions(dto);
  const root = h('div', { class: 'act-panel act-resuming' }, textEl, capturedEl);
  return {
    root,
    update(current) {
      updateCapturedActions(capturedEl, current);
    },
  };
}

function buildResolutionPanel(vs: 'resolved' | 'abandoned', dto: InterventionDto): ActPanel {
  const dl = h('dl', { class: 'resolution' });
  const capturedEl = buildCapturedActions(dto);
  const root = h('div', { class: `act-panel act-${vs}` }, dl, capturedEl);

  function fill(current: InterventionDto): void {
    const res = current.resolution;
    setChildren(
      dl,
      h('dt', null, vs === 'abandoned' ? 'Aborted by' : 'Resolved by'),
      h('dd', null, res?.by ?? 'Unknown'),
      h('dt', null, 'At'),
      h('dd', { class: 'mono num' }, res ? formatClock(res.at) : '—'),
      h('dt', null, 'Continued with'),
      h('dd', { id: 'continued-with' }, res ? continuedWithLabel(res, retryResumeOf(current)) : '—'),
      h('dt', null, 'Notes'),
      h('dd', null, res?.notes ? res.notes : 'No notes'),
    );
  }

  fill(dto);
  return {
    root,
    update(current) {
      fill(current);
      updateCapturedActions(capturedEl, current);
    },
  };
}
