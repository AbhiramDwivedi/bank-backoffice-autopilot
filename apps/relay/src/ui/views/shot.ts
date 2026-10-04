/**
 * The screenshot frame (figure#shot): the escalation still or a live loop of the session. Built
 * once per selected intervention and then only patched -- the img element is never recreated, so
 * swapping frames never flickers or drops an in-flight decode.
 *
 * The live loop is a sequential fetch/wait/fetch chain, gated on shotMode === 'live', the
 * intervention being `mine`, and the tab being visible. Any of those changing (including a
 * visibilitychange event, which the store never sees) aborts the in-flight fetch and stops it.
 */
import type { InterventionDto, RunDto } from '../../shared/api.js';
import type { AppContext } from '../context.js';
import { h, setAttr, setChildren, setText } from '../dom.js';
import { formatClock } from '../format.js';
import type { ShotMode, ViewState } from '../store.js';

interface ShotEls {
  figure: HTMLElement;
  escBtn: HTMLButtonElement;
  liveBtn: HTMLButtonElement;
  img: HTMLImageElement;
  placeholder: HTMLElement;
  indicator: HTMLElement;
  liveText: HTMLElement;
  liveUpdated: HTMLTimeElement;
  refreshBtn: HTMLButtonElement;
}

export interface ShotView {
  render(container: Element, dto: InterventionDto, run: RunDto | undefined, vs: ViewState): void;
}

export function createShotView(ctx: AppContext): ShotView {
  let mountedId: string | undefined;
  let els: ShotEls | undefined;

  let runningId: string | undefined;
  let currentAbort: AbortController | undefined;
  let liveTimer: ReturnType<typeof setTimeout> | undefined;
  let backoffMs = 1000;
  let toasted = false;
  let lastObjectUrl: string | undefined;
  let errorMessage: string | undefined;
  /** Intervention that already got its one-off frame on entering Live without control. */
  let autoRefreshedId: string | undefined;
  /** Capture time of the frame currently shown in live mode. */
  let lastFrameAt: string | undefined;
  let lastArgs: { id: string; runId: string; vs: ViewState; shotMode: ShotMode; createdAt: string } | undefined;

  function setMode(mode: ShotMode): void {
    ctx.store.set({ shotMode: mode });
  }

  function buildFigure(): ShotEls {
    const escBtn = h(
      'button',
      { type: 'button', role: 'radio', 'data-shot': 'escalation', 'aria-checked': 'false', onclick: () => setMode('escalation') },
      'At escalation',
    );
    const liveBtn = h(
      'button',
      { type: 'button', role: 'radio', 'data-shot': 'live', 'aria-checked': 'false', onclick: () => setMode('live') },
      'Live',
    );
    const toggle = h('div', { id: 'shot-toggle', class: 'segmented', role: 'radiogroup', 'aria-label': 'Screenshot' }, escBtn, liveBtn);
    // Radio-group keyboard model: arrows move the choice and the focus between the two options.
    toggle.addEventListener('keydown', (ev) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(ev.key)) return;
      ev.preventDefault();
      const next: ShotMode = ctx.store.get().shotMode === 'live' ? 'escalation' : 'live';
      setMode(next);
      (next === 'live' ? liveBtn : escBtn).focus();
    });

    const img = h('img', { id: 'shot-img', class: 'shot-img', alt: '' });
    const placeholder = h('p', { class: 'empty shot-placeholder', hidden: true }, 'No screenshot was captured at escalation.');
    const imgBox = h('div', { class: 'shot-imgbox' }, img, placeholder);

    const liveDot = h('span', { class: 'live-dot', 'aria-hidden': 'true' });
    const liveText = h('span', { class: 'live-text' });
    const liveUpdated = h('time', { id: 'live-updated', class: 'mono num', hidden: true });
    const refreshBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => void manualRefresh() }, 'Refresh');
    const indicator = h('div', { id: 'live-indicator', 'data-live': 'paused' }, liveDot, liveText, liveUpdated, refreshBtn);

    const figure = h('figure', { id: 'shot', class: 'shot-frame' }, toggle, imgBox, indicator);
    return { figure, escBtn, liveBtn, img, placeholder, indicator, liveText, liveUpdated, refreshBtn };
  }

  function updateToggle(shotMode: ShotMode): void {
    if (!els) return;
    setAttr(els.escBtn, 'aria-checked', shotMode === 'escalation' ? 'true' : 'false');
    setAttr(els.liveBtn, 'aria-checked', shotMode === 'live' ? 'true' : 'false');
    // Roving tabindex: Tab lands on the chosen option only.
    setAttr(els.escBtn, 'tabindex', shotMode === 'escalation' ? '0' : '-1');
    setAttr(els.liveBtn, 'tabindex', shotMode === 'live' ? '0' : '-1');
  }

  function updateImage(dto: InterventionDto, shotMode: ShotMode): void {
    if (!els) return;
    if (shotMode === 'escalation') {
      setAttr(els.img, 'alt', 'Screenshot taken when automation paused');
      if (!dto.hasScreenshot) {
        setAttr(els.img, 'hidden', true);
        setAttr(els.placeholder, 'hidden', false);
      } else {
        setAttr(els.placeholder, 'hidden', true);
        setAttr(els.img, 'hidden', false);
        setAttr(els.img, 'src', ctx.api.escalationScreenshotUrl(dto.id));
      }
    } else {
      setAttr(els.placeholder, 'hidden', true);
      setAttr(els.img, 'hidden', false);
      setAttr(els.img, 'alt', 'Live view of the session');
      // src is owned by the live loop / manual refresh below; leave whatever frame is already shown.
    }
  }

  /**
   * Escalation mode: a caption with the capture time (no live controls). Live mode: "Live" plus the
   * last refresh time while the loop runs; otherwise why it is paused and a one-off Refresh.
   */
  function updateIndicator(): void {
    if (!els) return;
    const on = runningId !== undefined;
    const mode = lastArgs?.shotMode ?? 'escalation';
    if (mode === 'escalation') {
      setAttr(els.indicator, 'data-live', 'off');
      setAttr(els.refreshBtn, 'hidden', true);
      setText(els.liveText, 'Captured when automation paused');
      setAttr(els.liveUpdated, 'hidden', lastArgs === undefined);
      if (lastArgs !== undefined) {
        setAttr(els.liveUpdated, 'datetime', lastArgs.createdAt);
        setText(els.liveUpdated, formatClock(lastArgs.createdAt));
      }
      return;
    }
    setAttr(els.indicator, 'data-live', on ? 'on' : 'paused');
    setAttr(els.refreshBtn, 'hidden', on);
    if (on) {
      setText(els.liveText, 'Live');
      setAttr(els.liveUpdated, 'hidden', false);
      if (lastFrameAt !== undefined) {
        setAttr(els.liveUpdated, 'datetime', lastFrameAt);
        setText(els.liveUpdated, `Updated ${formatClock(lastFrameAt)}`);
      }
    } else {
      setText(els.liveText, errorMessage ?? 'Live view paused. It refreshes while you have control.');
      setAttr(els.liveUpdated, 'hidden', lastFrameAt === undefined);
      if (lastFrameAt !== undefined) {
        setAttr(els.liveUpdated, 'datetime', lastFrameAt);
        setText(els.liveUpdated, `Last frame ${formatClock(lastFrameAt)}`);
      }
    }
  }

  function preload(url: string): Promise<void> {
    const probe = new Image();
    probe.src = url;
    return probe.decode().catch(() => undefined);
  }

  function applyFrame(url: string, capturedAt: string): void {
    if (!els) return;
    setAttr(els.img, 'src', url);
    const prev = lastObjectUrl;
    lastObjectUrl = url;
    if (prev !== undefined) URL.revokeObjectURL(prev);
    lastFrameAt = capturedAt;
  }

  async function tick(id: string, runId: string): Promise<void> {
    if (runningId !== id) return;
    const ctrl = new AbortController();
    currentAbort = ctrl;
    try {
      const { objectUrl, capturedAt } = await ctx.api.liveScreenshot(runId, ctrl.signal);
      if (runningId !== id) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      await preload(objectUrl);
      if (runningId !== id) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      applyFrame(objectUrl, capturedAt);
      backoffMs = 1000;
      errorMessage = undefined;
      updateIndicator();
      liveTimer = setTimeout(() => void tick(id, runId), backoffMs);
    } catch {
      if (ctrl.signal.aborted || runningId !== id) return;
      errorMessage = 'Live view is unavailable right now.';
      if (!toasted) {
        toasted = true;
        ctx.toast('warning', errorMessage);
      }
      backoffMs = 5000;
      updateIndicator();
      liveTimer = setTimeout(() => void tick(id, runId), backoffMs);
    }
  }

  function startLoop(id: string, runId: string): void {
    runningId = id;
    backoffMs = 1000;
    errorMessage = undefined;
    updateIndicator();
    void tick(id, runId);
  }

  function stopLoop(): void {
    if (currentAbort) {
      currentAbort.abort();
      currentAbort = undefined;
    }
    if (liveTimer !== undefined) {
      clearTimeout(liveTimer);
      liveTimer = undefined;
    }
    runningId = undefined;
  }

  function reconcileLive(): void {
    const args = lastArgs;
    const shouldRun = args !== undefined && args.shotMode === 'live' && args.vs === 'mine' && document.visibilityState === 'visible';
    const wantId = shouldRun ? args?.id : undefined;
    if (wantId !== runningId) {
      stopLoop();
      if (wantId !== undefined && args !== undefined) startLoop(wantId, args.runId);
      else updateIndicator();
    }
  }

  async function manualRefresh(): Promise<void> {
    const runId = lastArgs?.runId;
    if (runId === undefined) return;
    try {
      const { objectUrl, capturedAt } = await ctx.api.liveScreenshot(runId);
      await preload(objectUrl);
      applyFrame(objectUrl, capturedAt);
      errorMessage = undefined;
      updateIndicator();
    } catch {
      errorMessage = 'Live view is unavailable right now.';
      updateIndicator();
    }
  }

  document.addEventListener('visibilitychange', reconcileLive);

  return {
    render(container, dto, _run, vs) {
      const shotMode = ctx.store.get().shotMode;
      if (dto.id !== mountedId) {
        mountedId = dto.id;
        stopLoop();
        toasted = false;
        errorMessage = undefined;
        if (lastObjectUrl !== undefined) URL.revokeObjectURL(lastObjectUrl);
        lastObjectUrl = undefined;
        lastFrameAt = undefined;
        els = buildFigure();
        setChildren(container, els.figure);
      }
      updateToggle(shotMode);
      updateImage(dto, shotMode);
      lastArgs = { id: dto.id, runId: dto.runId, vs, shotMode, createdAt: dto.createdAt };
      reconcileLive();
      updateIndicator();
      // Live chosen without control: show one current frame rather than the escalation still.
      if (shotMode === 'live' && runningId === undefined && autoRefreshedId !== dto.id) {
        autoRefreshedId = dto.id;
        void manualRefresh();
      }
    },
  };
}
