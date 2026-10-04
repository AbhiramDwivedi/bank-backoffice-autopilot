/**
 * The detail pane (#detail): what the intervention is and why it stopped (summary first), the
 * control timeline, expected versus observed, then the screenshot and the URL.
 *
 * The body is rebuilt only when a field it displays changes (see `detailSignature`), not on every
 * heartbeat or captured action, so an open "More context", a text selection or a focused button
 * survives. The screenshot figure's container is created once and handed to `shot.ts`, which owns
 * the img element and the live loop, so it is never torn down mid-fetch.
 */
import type { InterventionDto, RunDto } from '../../shared/api.js';
import type { AppContext } from '../context.js';
import { byId, h, setChildren } from '../dom.js';
import { formatClock, shortRunId, titleOf } from '../format.js';
import { REASON_LABEL, RUN_KIND_LABEL } from '../labels.js';
import { selected, viewState, VIEW_STATE_LABEL, type ShotMode, type ViewState } from '../store.js';
import { buildKbdHint } from './queue.js';
import { createShotView, type ShotView } from './shot.js';
import { buildTimeline } from './timeline.js';

export function mountDetail(ctx: AppContext): void {
  const mainEl = byId('detail');
  const shotContainerEl = h('div', { class: 'shot-container' });
  const shotView: ShotView = createShotView(ctx);

  let prevDto: InterventionDto | undefined;
  let prevRun: RunDto | undefined;
  let prevOperator: string | undefined;
  let prevShotMode: ShotMode | undefined;
  let prevSelectedId: string | null | undefined;
  let prevHasAny: boolean | undefined;
  let prevSignature: string | undefined;

  function render(): void {
    const state = ctx.store.get();
    const dto = selected(state);
    const run = dto ? state.runs[dto.runId] : undefined;
    const hasAny = Object.keys(state.interventions).length > 0;

    if (
      dto === prevDto &&
      run === prevRun &&
      state.operator === prevOperator &&
      state.shotMode === prevShotMode &&
      state.selectedId === prevSelectedId &&
      hasAny === prevHasAny
    ) {
      return;
    }
    prevDto = dto;
    prevRun = run;
    prevOperator = state.operator;
    prevShotMode = state.shotMode;
    prevSelectedId = state.selectedId;
    prevHasAny = hasAny;

    if (!hasAny) {
      prevSignature = undefined;
      setChildren(mainEl, buildEmptyState());
      return;
    }
    if (!dto) {
      prevSignature = undefined;
      setChildren(mainEl, buildNoneSelected());
      return;
    }

    const vs = viewState(dto, run, state.operator);
    const signature = detailSignature(dto, vs);
    if (signature !== prevSignature) {
      prevSignature = signature;
      setChildren(mainEl, buildDetail(ctx, dto, vs, shotContainerEl));
    }
    shotView.render(shotContainerEl, dto, run, vs);
  }

  ctx.store.subscribe(render);
  render();
}

/** Every field the detail body displays. Lease, heartbeat and captured actions are not among them. */
function detailSignature(dto: InterventionDto, vs: ViewState): string {
  return JSON.stringify([
    dto.id,
    vs,
    dto.heldBy,
    dto.capabilityId,
    dto.goal,
    dto.stepId,
    dto.runKind,
    dto.createdAt,
    dto.reason,
    dto.currentUrl,
    dto.context,
    dto.timeline,
    dto.resolution,
    dto.reverifyFailure,
    dto.leaseExpiredNote,
  ]);
}

function buildEmptyState(): HTMLElement {
  return h(
    'section',
    { id: 'empty-state', class: 'empty' },
    h('h1', null, 'Nothing needs you right now'),
    h(
      'p',
      null,
      "Relay is where you step in when automation can't continue safely. When a run pauses for a person, it appears in the queue; take control, finish the step in the live browser, and hand it back.",
    ),
  );
}

function buildNoneSelected(): HTMLElement {
  return h('div', { class: 'detail-empty-prompt' }, h('p', { class: 'meta' }, 'Select an intervention from the queue.'), buildKbdHint());
}

function buildDetail(ctx: AppContext, dto: InterventionDto, vs: ViewState, shotContainerEl: HTMLElement): HTMLElement {
  return h(
    'div',
    { class: 'detail-body' },
    buildHeader(dto, vs),
    ...buildCallouts(dto),
    buildTimeline(dto, vs),
    buildReasonMessage(dto),
    buildCompare(dto),
    shotContainerEl,
    buildCurrentUrl(ctx, dto),
  );
}

function buildHeader(dto: InterventionDto, vs: ViewState): HTMLElement {
  const stepText = dto.stepId !== undefined ? `Step ${dto.stepId}` : 'No step recorded';
  const pillText = vs === 'held' ? `Held by ${dto.heldBy ?? 'another operator'}` : VIEW_STATE_LABEL[vs];
  return h(
    'header',
    { class: 'detail-header' },
    h('h1', { id: 'detail-title' }, titleOf(dto)),
    h(
      'div',
      { class: 'detail-meta meta' },
      h('span', { class: 'mono', title: dto.runId }, shortRunId(dto.runId)),
      h('span', null, RUN_KIND_LABEL[dto.runKind]),
      h('span', { id: 'step-name' }, stepText),
      h('time', { class: 'mono num', datetime: dto.createdAt }, formatClock(dto.createdAt)),
    ),
    h('span', { id: 'state-pill', class: 'pill', 'data-state': vs }, pillText),
  );
}

function buildCallouts(dto: InterventionDto): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (dto.reverifyFailure !== undefined) {
    out.push(
      h(
        'div',
        { class: 'callout', 'data-kind': 'danger' },
        `Automation could not confirm the page after the last hand-back: ${dto.reverifyFailure}. Take control and check the page.`,
      ),
    );
  }
  if (dto.leaseExpiredNote !== undefined) {
    out.push(h('div', { class: 'callout', 'data-kind': 'warning' }, dto.leaseExpiredNote));
  }
  return out;
}

function buildCurrentUrl(ctx: AppContext, dto: InterventionDto): HTMLElement {
  const url = dto.currentUrl;
  const urlEl = h('span', { id: 'current-url', class: 'mono' }, url ?? 'Not provided');
  const copyBtn =
    url !== undefined
      ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => handleCopy(ctx, url, urlEl) }, 'Copy')
      : null;
  return h('div', { class: 'current-url-row' }, h('span', { class: 'label' }, 'URL'), urlEl, copyBtn);
}

function handleCopy(ctx: AppContext, url: string, urlEl: HTMLElement): void {
  navigator.clipboard.writeText(url).then(
    () => ctx.toast('success', 'URL copied'),
    () => selectTextNode(urlEl),
  );
}

function selectTextNode(el: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function buildReasonMessage(dto: InterventionDto): HTMLElement {
  return h(
    'div',
    { id: 'reason-message', class: 'reason-message' },
    h('span', { class: 'chip chip-reason', 'data-reason': dto.reason.code, title: dto.reason.code }, REASON_LABEL[dto.reason.code]),
    h('p', null, dto.reason.message),
  );
}

function buildCompare(dto: InterventionDto): HTMLElement {
  const context = dto.context;
  const expected = context?.expected;
  const observed = context?.observed;
  const section = h(
    'section',
    { id: 'compare', class: 'compare' },
    h('div', { class: 'compare-col' }, h('h3', { class: 'label' }, 'Expected'), h('div', { id: 'expected' }, buildContextValue(expected))),
    h('div', { class: 'compare-col' }, h('h3', { class: 'label' }, 'Observed'), h('div', { id: 'observed' }, buildContextValue(observed))),
  );
  if (context !== undefined) {
    const moreKeys = Object.keys(context).filter((k) => k !== 'expected' && k !== 'observed');
    if (moreKeys.length > 0) {
      const dl = h('dl', { class: 'context-dl' });
      for (const key of moreKeys) {
        dl.appendChild(h('dt', null, key));
        dl.appendChild(h('dd', null, buildContextValue(context[key])));
      }
      section.appendChild(h('details', { class: 'more-context' }, h('summary', null, 'More context'), dl));
    }
  }
  return section;
}

function buildContextValue(v: unknown): Node {
  if (v === undefined) return h('p', { class: 'meta' }, 'Not provided');
  if (typeof v === 'string') return h('p', null, v);
  return h('pre', { class: 'mono compare-pre' }, JSON.stringify(v, null, 2));
}
