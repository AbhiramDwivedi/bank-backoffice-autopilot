/**
 * What every view receives. Built once in main.ts; views never create their own store, client or
 * dialogs.
 */
import type { RelayApi } from './api.js';
import type { Store, ToastKind } from './store.js';

export interface ConfirmOptions {
  title: string;
  body: string;
  /** Label of the confirming (destructive) button, e.g. "Abort run". */
  confirmLabel: string;
}

export interface AppContext {
  store: Store;
  api: RelayApi;
  /** Shows a toast. Errors stay until dismissed; others auto-dismiss. */
  toast(kind: ToastKind, message: string): void;
  /** In-page confirmation (the viewer may block `window.confirm`). Resolves true on confirm. Cancel has focus by default. */
  confirm(opts: ConfirmOptions): Promise<boolean>;
}
