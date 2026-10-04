/**
 * The top bar: the connection indicator, the operator name field, and the theme switch. Each
 * piece reads and writes exactly one slice of store state (connection / operator / theme) and
 * nothing else in the app touches these elements.
 */
import type { AppContext } from '../context.js';
import { byId, setAttr, setText } from '../dom.js';
import type { ThemeChoice } from '../store.js';
import { saveOperator, saveTheme } from '../store.js';

const CONN_LABEL: Record<string, string> = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
};

export function mountTopbar(ctx: AppContext): void {
  mountConnection(ctx);
  mountOperator(ctx);
  mountThemeSwitch(ctx);
}

function mountConnection(ctx: AppContext): void {
  const status = byId('conn-status');
  const label = status.querySelector<HTMLElement>('.conn-label');

  const render = (): void => {
    const state = ctx.store.get().connection;
    setAttr(status, 'data-state', state);
    if (label) setText(label, CONN_LABEL[state] ?? state);
  };

  render();
  ctx.store.subscribe((s, prev) => {
    if (s.connection !== prev.connection) render();
  });
}

function mountOperator(ctx: AppContext): void {
  const input = byId<HTMLInputElement>('operator-name');

  const render = (): void => {
    if (document.activeElement !== input) input.value = ctx.store.get().operator;
  };

  render();
  ctx.store.subscribe((s, prev) => {
    if (s.operator !== prev.operator) render();
  });

  const commit = (): void => {
    const next = input.value.trim().slice(0, 100) || 'operator';
    input.value = next;
    if (next !== ctx.store.get().operator) {
      saveOperator(next);
      ctx.store.set({ operator: next });
    }
  };

  input.addEventListener('change', commit);
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
  });
}

function mountThemeSwitch(ctx: AppContext): void {
  const group = byId('theme-switch');
  const buttons = Array.from(group.querySelectorAll<HTMLButtonElement>('[data-theme-choice]'));

  const apply = (choice: ThemeChoice): void => {
    if (choice === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = choice;
  };

  const render = (): void => {
    const current = ctx.store.get().theme;
    for (const btn of buttons) {
      const checked = btn.dataset.themeChoice === current;
      setAttr(btn, 'aria-checked', checked ? 'true' : 'false');
      setAttr(btn, 'tabindex', checked ? '0' : '-1');
    }
  };

  render();
  ctx.store.subscribe((s, prev) => {
    if (s.theme !== prev.theme) render();
  });

  const select = (choice: ThemeChoice, focusButton: boolean): void => {
    apply(choice);
    saveTheme(choice);
    ctx.store.set({ theme: choice });
    if (focusButton) buttons.find((b) => b.dataset.themeChoice === choice)?.focus();
  };

  buttons.forEach((btn, i) => {
    btn.addEventListener('click', () => {
      const choice = btn.dataset.themeChoice as ThemeChoice | undefined;
      if (choice) select(choice, false);
    });
    btn.addEventListener('keydown', (e) => {
      const dir = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : 0;
      if (dir === 0) return;
      e.preventDefault();
      const next = buttons[(i + dir + buttons.length) % buttons.length];
      const choice = next?.dataset.themeChoice as ThemeChoice | undefined;
      if (choice) select(choice, true);
    });
  });
}
