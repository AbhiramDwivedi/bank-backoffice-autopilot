/**
 * Where captured human-action records go when nothing else is watching this document.
 *
 * A production tag would batch these records and POST them to a collector endpoint
 * (`navigator.sendBeacon`, or `fetch` with `keepalive: true`) instead of anything below: that is
 * the only durable delivery mechanism once the page unloads. This package ships no endpoint and no
 * network code (zero dependencies, browser-only), and its own tests run against fixture pages with
 * nothing listening on the network, so two dev/test-only fallbacks stand in for that collector:
 *
 *  - when a driver (Playwright) has installed `window.__cuHumanAction`, every record goes straight
 *    to it and nothing is buffered;
 *  - otherwise records are kept in a small bounded in-page buffer (`drain()`/`events`, for a test or
 *    a script sharing this document to pull) and broadcast with `window.postMessage`, so a page or
 *    test listening for `message` events sees them too, again with no network involved.
 */
import { ACTION_MESSAGE_TYPE, EVENT_BUFFER_MAX } from './constants.js';
import type { ActionMessage, HumanActionRecord } from './types.js';

/** Where `createCapture` sends every record it builds. */
export interface Sink {
  send(record: HumanActionRecord): void;
  /** Returns the buffered records in order and empties the buffer. */
  drain(): HumanActionRecord[];
  /** The buffer backing `drain()`. Always empty while a binding is present. */
  readonly events: HumanActionRecord[];
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (!value) return false;
  const t = typeof value;
  if (t !== 'object' && t !== 'function') return false;
  return typeof (value as { then?: unknown }).then === 'function';
}

/** Creates a fresh sink with an empty buffer. */
export function createSink(): Sink {
  const buffer: HumanActionRecord[] = [];

  function pushBounded(record: HumanActionRecord): void {
    buffer.push(record);
    if (buffer.length > EVENT_BUFFER_MAX) buffer.splice(0, buffer.length - EVENT_BUFFER_MAX);
  }

  function fallback(record: HumanActionRecord): void {
    pushBounded(record);
    try {
      const message: ActionMessage = { type: ACTION_MESSAGE_TYPE, action: record };
      window.postMessage(message, '*');
    } catch {
      /* postMessage unavailable (or the record failed structured clone); it is still buffered */
    }
  }

  return {
    send(record: HumanActionRecord): void {
      const binding = window.__cuHumanAction;
      if (typeof binding === 'function') {
        try {
          const result = binding(record);
          if (isThenable(result)) {
            Promise.resolve(result).catch(() => {
              /* the binding's own promise rejected; the record was already handed off */
            });
          }
        } catch {
          // The binding threw synchronously (no promise to swallow): treat it as absent for this
          // record so the action is not lost.
          fallback(record);
        }
        return;
      }
      fallback(record);
    },

    drain(): HumanActionRecord[] {
      return buffer.splice(0, buffer.length);
    },

    get events(): HumanActionRecord[] {
      return buffer;
    },
  };
}
