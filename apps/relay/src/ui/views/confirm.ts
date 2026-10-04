/**
 * In-page confirmation, backed by `<dialog id="confirm-dialog">` from the HTML shell. Never uses
 * `window.confirm` (the viewer may block it). The dialog's form uses `method="dialog"`, so Escape
 * and the Cancel button both close it with an empty `returnValue`; only the Ok button sets it to
 * `"ok"`. Calls are queued: a second confirmation while one is open waits for the first to close,
 * since there is only one dialog element to show it in.
 */
import type { ConfirmOptions } from '../context.js';
import { byId, setText } from '../dom.js';

export function createConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
  const dialog = byId<HTMLDialogElement>('confirm-dialog');
  const title = byId('confirm-title');
  const body = byId('confirm-body');
  const okBtn = byId<HTMLButtonElement>('confirm-ok');
  const cancelBtn = byId<HTMLButtonElement>('confirm-cancel');

  let queue: Promise<unknown> = Promise.resolve();

  function openOnce(opts: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      setText(title, opts.title);
      setText(body, opts.body);
      setText(okBtn, opts.confirmLabel);

      const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

      const onClose = (): void => {
        dialog.removeEventListener('close', onClose);
        resolve(dialog.returnValue === 'ok');
        previouslyFocused?.focus();
      };
      dialog.addEventListener('close', onClose);

      dialog.showModal();
      cancelBtn.focus();
    });
  }

  return function confirm(opts: ConfirmOptions): Promise<boolean> {
    const result = queue.then(() => openOnce(opts));
    queue = result.catch(() => undefined);
    return result;
  };
}
