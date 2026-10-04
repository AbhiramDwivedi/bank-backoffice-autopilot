/**
 * The single document-level keyboard listener. `j`/`k` (and the arrow keys, while focus is
 * already on a card) move focus around the queue without changing the selection; `t`/`h`/`a` act
 * on the selected intervention by delegating to the same controls a click would use, so a
 * shortcut that does not apply is simply a no-op (a disabled or absent button ignores `.click()`).
 */
import type { AppContext } from './context.js';
import { queueOrder, selected, viewState } from './store.js';

export function mountKeyboard(ctx: AppContext): void {
  document.addEventListener('keydown', (ev) => {
    if (shouldIgnore(ev)) return;

    switch (ev.key) {
      case 'j':
        moveFocus(ctx, 1);
        ev.preventDefault();
        break;
      case 'ArrowDown':
        if (!isCardFocused()) return;
        moveFocus(ctx, 1);
        ev.preventDefault();
        break;
      case 'k':
        moveFocus(ctx, -1);
        ev.preventDefault();
        break;
      case 'ArrowUp':
        if (!isCardFocused()) return;
        moveFocus(ctx, -1);
        ev.preventDefault();
        break;
      case 't':
        tryTake();
        break;
      case 'h':
        tryHandBack();
        break;
      case 'a':
        tryAbort();
        break;
      default:
        break;
    }
  });

  function tryTake(): void {
    if (currentViewState(ctx) !== 'paused') return;
    document.getElementById('take-control')?.click();
  }

  function tryHandBack(): void {
    if (currentViewState(ctx) !== 'mine') return;
    const form = document.getElementById('handback');
    if (form instanceof HTMLFormElement) form.requestSubmit();
  }

  function tryAbort(): void {
    const vs = currentViewState(ctx);
    if (vs !== 'paused' && vs !== 'mine' && vs !== 'held') return;
    document.getElementById('abort')?.click();
  }
}

function currentViewState(ctx: AppContext) {
  const state = ctx.store.get();
  const dto = selected(state);
  if (!dto) return undefined;
  return viewState(dto, state.runs[dto.runId], state.operator);
}

function shouldIgnore(ev: KeyboardEvent): boolean {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return true;
  const dialog = document.getElementById('confirm-dialog');
  if (dialog instanceof HTMLDialogElement && dialog.open) return true;
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    const tag = active.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (active.isContentEditable) return true;
  }
  return false;
}

function isCardFocused(): boolean {
  return document.activeElement instanceof HTMLElement && document.activeElement.classList.contains('qcard');
}

function moveFocus(ctx: AppContext, dir: 1 | -1): void {
  const state = ctx.store.get();
  const order = queueOrder(state);
  if (order.length === 0) return;

  const active = document.activeElement;
  const focusedId =
    active instanceof HTMLElement && active.classList.contains('qcard') ? active.dataset.interventionId : undefined;
  const fromId = focusedId ?? state.selectedId ?? undefined;
  const idx = fromId !== undefined ? order.indexOf(fromId) : -1;

  const nextIdx = idx === -1 ? (dir === 1 ? 0 : order.length - 1) : (idx + dir + order.length) % order.length;
  const nextId = order[nextIdx];
  if (nextId === undefined) return;
  focusCard(nextId);
}

function focusCard(id: string): void {
  const el = document.querySelector<HTMLElement>(`.qcard[data-intervention-id="${CSS.escape(id)}"]`);
  el?.focus();
}
