/**
 * The queue pane (#queue): Open, In progress and Resolved, oldest-first within a group. Cards are
 * patched in place (patchList) so keyboard focus and the selection outline survive an SSE update.
 * Ages tick from the shared 1 s ticker; nothing else about a card changes between store updates.
 */
import type { InterventionDto } from '../../shared/api.js';
import type { AppContext } from '../context.js';
import { byId, h, patchList, setAttr, setChildren, setText } from '../dom.js';
import { formatAge, shortRunId, titleOf } from '../format.js';
import { REASON_LABEL } from '../labels.js';
import { queueGroups, select, serverNow, viewState, type RelayState, type ViewState } from '../store.js';
import { onTick } from './ticker.js';

type GroupKey = 'open' | 'in-progress' | 'resolved';

const GROUP_LABEL: Record<GroupKey, string> = {
  open: 'Open',
  'in-progress': 'In progress',
  resolved: 'Resolved',
};

const GROUP_EMPTY_TEXT: Record<GroupKey, string> = {
  open: 'Nothing waiting',
  'in-progress': 'Nobody is working on one',
  resolved: 'Nothing resolved yet',
};

export function mountQueue(ctx: AppContext): void {
  const nav = byId('queue');

  // Built once. Renders patch counts and lists in place, so the card that has keyboard focus
  // survives every SSE update (heartbeats arrive every 5 s while an operator holds control).
  const openCountEl = h('span', { class: 'pane-head-count num' }, '0 open');
  const groups = (['open', 'in-progress', 'resolved'] as const).map((key) => buildGroup(key));
  setChildren(nav, h('div', { class: 'pane-head' }, h('h2', null, 'Queue'), openCountEl), ...groups.map((g) => g.section), buildKbdHint());

  let prevInterventions: RelayState['interventions'] | undefined;
  let prevRuns: RelayState['runs'] | undefined;
  let prevSelectedId: string | null | undefined;
  let prevOperator: string | undefined;

  function render(): void {
    const state = ctx.store.get();
    if (
      state.interventions === prevInterventions &&
      state.runs === prevRuns &&
      state.selectedId === prevSelectedId &&
      state.operator === prevOperator
    ) {
      return;
    }
    prevInterventions = state.interventions;
    prevRuns = state.runs;
    prevSelectedId = state.selectedId;
    prevOperator = state.operator;

    const q = queueGroups(state);
    const itemsByKey: Record<GroupKey, readonly InterventionDto[]> = { open: q.open, 'in-progress': q.inProgress, resolved: q.resolved };
    setText(openCountEl, `${q.open.length} open`);
    for (const g of groups) {
      const items = itemsByKey[g.key];
      setText(g.countEl, String(items.length));
      setAttr(g.emptyEl, 'hidden', items.length > 0);
      setAttr(g.list, 'hidden', items.length === 0);
      patchList(
        g.list,
        items,
        (dto) => dto.id,
        (dto) => buildCard(dto, ctx),
        (li, dto) => updateCard(li as HTMLLIElement, dto, state),
      );
    }
  }

  ctx.store.subscribe(render);
  render();

  onTick(() => {
    const now = serverNow(ctx.store.get());
    for (const el of Array.from(nav.querySelectorAll<HTMLTimeElement>('time.age'))) {
      const dt = el.getAttribute('datetime');
      if (dt === null) continue;
      setText(el, formatAge(now - new Date(dt).getTime()));
    }
  });
}

interface GroupEls {
  key: GroupKey;
  section: HTMLElement;
  countEl: HTMLElement;
  emptyEl: HTMLElement;
  list: HTMLUListElement;
}

function buildGroup(key: GroupKey): GroupEls {
  const headingId = `queue-group-${key}-h`;
  const countEl = h('span', { class: 'queue-group-count num' }, '0');
  const emptyEl = h('p', { class: 'queue-empty' }, GROUP_EMPTY_TEXT[key]);
  const list = h('ul', { class: 'queue-list' });
  const section = h(
    'section',
    { class: 'queue-group', 'data-group': key, 'aria-labelledby': headingId },
    h('h3', { id: headingId }, GROUP_LABEL[key], ' ', countEl),
    emptyEl,
    list,
  );
  return { key, section, countEl, emptyEl, list };
}

function buildCard(dto: InterventionDto, ctx: AppContext): HTMLLIElement {
  const li = h('li', null);
  const btn = h('button', {
    type: 'button',
    class: 'qcard',
    'data-intervention-id': dto.id,
    onclick: () => select(ctx.store, dto.id),
  });
  li.appendChild(btn);
  return li;
}

function updateCard(li: HTMLLIElement, dto: InterventionDto, state: RelayState): void {
  const btn = li.firstElementChild as HTMLButtonElement;
  const vs = viewState(dto, state.runs[dto.runId], state.operator);
  setAttr(btn, 'data-status', dto.status);
  setAttr(btn, 'aria-current', state.selectedId === dto.id ? 'true' : false);

  const title = titleOf(dto);
  const runShort = shortRunId(dto.runId);

  setChildren(
    btn,
    h('span', { class: 'qcard-title' }, title),
    h(
      'div',
      { class: 'qcard-meta meta' },
      h('span', { class: 'mono', title: dto.runId }, runShort),
      dto.stepId !== undefined ? h('span', null, `Step ${dto.stepId}`) : null,
    ),
    h(
      'div',
      { class: 'qcard-row' },
      h(
        'span',
        { class: 'chip chip-reason', 'data-reason': dto.reason.code, title: dto.reason.code },
        REASON_LABEL[dto.reason.code],
      ),
      h('time', { class: 'age', datetime: dto.createdAt }, formatAge(serverNow(state) - new Date(dto.createdAt).getTime())),
    ),
    h('div', { class: 'qcard-holder meta', 'data-state': vs }, holderText(dto, vs)),
  );
}

function holderText(dto: InterventionDto, vs: ViewState): string {
  switch (vs) {
    case 'paused':
      return 'Waiting for an operator';
    case 'mine':
      return 'You have control';
    case 'held':
      return `Held by ${dto.heldBy ?? 'another operator'}`;
    case 'resuming':
      return 'Resuming';
    case 'resolved':
      return `Resolved by ${dto.resolution?.by ?? 'an operator'}`;
    case 'abandoned':
      return `Aborted by ${dto.resolution?.by ?? 'an operator'}`;
  }
}

export function buildKbdHint(): HTMLElement {
  const pair = (keys: readonly string[], action: string): HTMLElement =>
    h('li', null, ...keys.map((k) => h('kbd', null, k)), h('span', null, action));
  return h(
    'ul',
    { class: 'kbd-hint', 'aria-label': 'Keyboard shortcuts' },
    pair(['j', 'k'], 'move'),
    pair(['Enter'], 'open'),
    pair(['t'], 'take'),
    pair(['h'], 'hand back'),
    pair(['a'], 'abort'),
  );
}
