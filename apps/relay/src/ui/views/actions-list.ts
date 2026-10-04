/**
 * The captured-actions list, shared by every Act-pane view state. Rendered with patchList keyed
 * by index+timestamp so a growing list reuses existing rows, and pinned to the bottom across
 * updates when the operator was already scrolled there. `type: 'input'` never shows a value: not
 * the redacted marker's neighbor text, not `target.text` -- defense in depth even though the core
 * never sends one.
 */
import type { CapturedAction, InterventionDto } from '../../shared/api.js';
import { h, patchList, setChildren, setText } from '../dom.js';
import { actionTargetLabel, formatClock, frameLabel } from '../format.js';
import { ACTION_TYPE_LABEL } from '../labels.js';

interface Row {
  action: CapturedAction;
  index: number;
}

/** Builds the `#captured` section once for an intervention. Call `updateCapturedActions` after. */
export function buildCapturedActions(dto: InterventionDto): HTMLElement {
  const section = h(
    'section',
    { id: 'captured' },
    h('div', { class: 'section-head' }, h('h2', null, 'Captured actions'), h('span', { class: 'section-head-count num' })),
    h('ol', { id: 'actions', class: 'actions-list' }),
  );
  updateCapturedActions(section, dto);
  return section;
}

/** Updates an existing `#captured` section in place: the count, the capture-mode callout, and the rows. */
export function updateCapturedActions(section: HTMLElement, dto: InterventionDto): void {
  const countEl = section.querySelector('.section-head-count');
  if (countEl) setText(countEl, String(dto.humanActions.length));

  let callout = section.querySelector('.callout');
  if (dto.captureMode === 'none') {
    if (!callout) {
      callout = h(
        'div',
        { class: 'callout', 'data-kind': 'warning' },
        "Relay can't record actions in this session. Describe what you did in the notes.",
      );
      section.insertBefore(callout, section.querySelector('#actions'));
    }
  } else if (callout) {
    callout.remove();
  }

  const ol = section.querySelector('#actions');
  if (!(ol instanceof HTMLOListElement)) return;
  const wasPinnedToBottom = ol.scrollHeight - ol.scrollTop - ol.clientHeight < 4;

  const rows: Row[] = dto.humanActions.map((action, index) => ({ action, index }));
  patchList(
    ol,
    rows,
    (row) => `${row.index}-${row.action.ts}`,
    (row) => buildRow(row),
    (el, row) => updateRow(el as HTMLLIElement, row),
  );

  if (wasPinnedToBottom) ol.scrollTop = ol.scrollHeight;
}

function buildRow(row: Row): HTMLLIElement {
  const li = h('li', { class: 'action' });
  updateRow(li, row);
  return li;
}

/**
 * Every row has the same two lines: type, target and time; then the frame and one detail (the
 * key pressed, the URL navigated to, or the redaction marker for an input). An input row never
 * shows a value or `target.text`: the core does not store them and the UI would not render them.
 */
function updateRow(li: HTMLLIElement, { action }: Row): void {
  li.dataset.type = action.type;
  const detail: HTMLElement[] = [h('span', { class: 'action-frame' }, frameLabel(action.frame))];
  if (action.type === 'keypress' && action.key !== undefined) {
    detail.push(h('span', { class: 'action-key' }, h('kbd', null, action.key)));
  }
  if (action.type === 'navigate' && action.url !== undefined) {
    detail.push(h('span', { class: 'action-url mono' }, action.url));
  }
  if (action.type === 'input') {
    detail.push(h('span', { class: 'redacted-marker' }, 'value hidden'));
  }
  setChildren(
    li,
    h('span', { class: 'action-type mono' }, ACTION_TYPE_LABEL[action.type]),
    h('span', { class: 'action-target' }, actionTargetLabel(action)),
    h('time', { class: 'action-time mono num', datetime: action.ts }, formatClock(action.ts)),
    h('span', { class: 'action-detail meta' }, detail),
  );
}
