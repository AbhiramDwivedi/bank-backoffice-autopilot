/**
 * The control timeline: the signature piece. Five fixed stops (automation, paused, human,
 * resuming, automation-return); which are reached and which is current come from the dto's
 * timeline entries, read as one "round" -- the most recent paused/human/resuming/return cycle, so
 * a lease expiry or a failed re-check that reopened the intervention starts the round over instead
 * of showing a stale earlier one.
 */
import type { InterventionDto, TimelineEntry } from '../../shared/api.js';
import { h } from '../dom.js';
import { formatClock } from '../format.js';
import type { ViewState } from '../store.js';

type StopKey = 'automation' | 'paused' | 'human' | 'resuming' | 'automation-return';

const STOPS: { key: StopKey; label: string }[] = [
  { key: 'automation', label: 'Automation' },
  { key: 'paused', label: 'Paused' },
  { key: 'human', label: 'Human' },
  { key: 'resuming', label: 'Resuming' },
  { key: 'automation-return', label: 'Automation' },
];

interface Round {
  pausedAt: string;
  humanAt: string | undefined;
  resumingAt: string | undefined;
  returnAt: string | undefined;
}

function lastIndexWhere<T>(items: readonly T[], pred: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item !== undefined && pred(item)) return i;
  }
  return -1;
}

function computeRound(dto: InterventionDto): Round {
  const timeline: readonly TimelineEntry[] = dto.timeline;
  const pausedIdx = lastIndexWhere(timeline, (e) => e.to === 'paused');
  const pausedAt = pausedIdx !== -1 ? (timeline[pausedIdx]?.at ?? dto.createdAt) : dto.createdAt;

  const afterPaused = pausedIdx !== -1 ? timeline.slice(pausedIdx + 1) : timeline;
  const humanIdx = lastIndexWhere(afterPaused, (e) => e.to === 'human');
  const humanAt = humanIdx !== -1 ? afterPaused[humanIdx]?.at : undefined;

  const afterHuman = humanIdx !== -1 ? afterPaused.slice(humanIdx + 1) : [];
  const resumingIdx = lastIndexWhere(afterHuman, (e) => e.to === 'resuming');
  const resumingAt = resumingIdx !== -1 ? afterHuman[resumingIdx]?.at : undefined;

  const afterResuming = resumingIdx !== -1 ? afterHuman.slice(resumingIdx + 1) : [];
  const returnIdx = lastIndexWhere(afterResuming, (e) => e.to === 'automation');
  const returnAt = returnIdx !== -1 ? afterResuming[returnIdx]?.at : undefined;

  return { pausedAt, humanAt, resumingAt, returnAt };
}

function currentStopFor(vs: ViewState): StopKey | undefined {
  switch (vs) {
    case 'paused':
      return 'paused';
    case 'mine':
    case 'held':
      return 'human';
    case 'resuming':
      return 'resuming';
    case 'resolved':
      return 'automation-return';
    case 'abandoned':
      return undefined;
  }
}

function timeFor(key: StopKey, round: Round): string | undefined {
  switch (key) {
    case 'automation':
      return undefined;
    case 'paused':
      return round.pausedAt;
    case 'human':
      return round.humanAt;
    case 'resuming':
      return round.resumingAt;
    case 'automation-return':
      return round.returnAt;
  }
}

function reachedFor(key: StopKey, round: Round): boolean {
  switch (key) {
    case 'automation':
    case 'paused':
      return true;
    case 'human':
      return round.humanAt !== undefined;
    case 'resuming':
      return round.resumingAt !== undefined;
    case 'automation-return':
      return round.returnAt !== undefined;
  }
}

function buildStop(key: StopKey, label: string, reached: boolean, current: boolean, at: string | undefined): HTMLLIElement {
  return h(
    'li',
    {
      class: 'stop',
      'data-stop': key,
      'data-reached': reached ? 'true' : 'false',
      ...(current ? { 'aria-current': 'step' } : {}),
    },
    h('span', { class: 'stop-node', 'aria-hidden': 'true' }),
    h('span', { class: 'stop-label' }, label),
    at !== undefined ? h('time', { class: 'stop-time mono num', datetime: at }, formatClock(at)) : null,
  );
}

/** Builds the whole control-timeline section (the ol and, once abandoned, its caption). */
export function buildTimeline(dto: InterventionDto, vs: ViewState): HTMLElement {
  const round = computeRound(dto);
  const ended = dto.status === 'abandoned';
  const currentKey = ended ? undefined : currentStopFor(vs);

  const ol = h(
    'ol',
    { id: 'timeline', class: 'timeline', 'aria-label': 'Control', ...(ended ? { 'data-ended': 'aborted' } : {}) },
    ...STOPS.map(({ key, label }) => buildStop(key, label, reachedFor(key, round), key === currentKey, timeFor(key, round))),
  );

  if (ended && dto.resolution) {
    const caption = h(
      'p',
      { class: 'timeline-caption meta' },
      `Run aborted at ${formatClock(dto.resolution.at)} by ${dto.resolution.by}`,
    );
    return h('div', { class: 'timeline-wrap' }, ol, caption);
  }
  return h('div', { class: 'timeline-wrap' }, ol);
}
