/**
 * Ref registry: binds opaque refs to live element handles.
 * - Observation refs `e1..eN` are replaced wholesale on every observe().
 * - Resolution refs `r1, r2, ...` (from resolve()) survive observe() so a resolve -> act pair
 *   keeps working; the oldest are evicted beyond MAX_RESOLVED.
 * A handle whose element was detached (navigation) makes act fail with element_not_found.
 */
import type { ElementHandle, Frame } from 'playwright';
import type { FramePath } from '@cu/core/schema';
import type { RecordContext } from '@cu/core/surface';

/** Descriptive snapshot of an element (tag/role/name/text) at the time its ref was bound. */
export interface RefInfo {
  tag?: string;
  role?: string;
  name?: string;
  text?: string;
}

/** A live element handle bound to a ref, plus enough context to re-find it and describe it. */
export interface RefEntry {
  frame: Frame;
  framePath: FramePath;
  handle: ElementHandle<Element>;
  /** Snapshot of what the element looked like when bound (never a value). */
  info?: RefInfo;
  /** Observation refs only: the recorder-only context (`Surface.recordContextOf`); real text, never reported. */
  recordContext?: RecordContext;
}

const MAX_RESOLVED = 200;

/** Binds opaque refs to live element handles; see the module header for observation vs. resolution refs. */
export class RefRegistry {
  private observed = new Map<string, RefEntry>();
  private resolved = new Map<string, RefEntry>();
  private seq = 0;

  /** Replace all observation refs (disposing the old handles). */
  replaceObserved(entries: Map<string, RefEntry>): void {
    for (const e of this.observed.values()) void e.handle.dispose().catch(() => undefined);
    this.observed = entries;
  }

  /** Bind a resolution result; returns its new ref ("r<n>"). */
  bindResolved(entry: RefEntry): string {
    const ref = `r${++this.seq}`;
    this.resolved.set(ref, entry);
    while (this.resolved.size > MAX_RESOLVED) {
      const oldest = this.resolved.keys().next().value as string;
      void this.resolved.get(oldest)?.handle.dispose().catch(() => undefined);
      this.resolved.delete(oldest);
    }
    return ref;
  }

  get(ref: string): RefEntry | undefined {
    return this.observed.get(ref) ?? this.resolved.get(ref);
  }

  /** An entry of the latest observation only (`e<n>`), never a resolution ref. */
  getObserved(ref: string): RefEntry | undefined {
    return this.observed.get(ref);
  }

  clear(): void {
    this.replaceObserved(new Map());
    for (const e of this.resolved.values()) void e.handle.dispose().catch(() => undefined);
    this.resolved.clear();
  }
}
