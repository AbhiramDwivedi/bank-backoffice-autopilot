/**
 * Small stdlib-ish helpers shared by record.ts and its lib/* modules.
 */

/** Real-time sleep (used to hold a recorded page's final state for the required duration). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Runs `tasks` with at most `concurrency` in flight at once, preserving each task's result at
 * its original index. Used to batch independent Playwright recording contexts (slides, terminal
 * renders) so the whole pipeline stays fast without opening dozens of contexts at once.
 */
export async function runBatched<T>(tasks: readonly (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]!();
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** HTML-escapes a plain-text string for safe embedding inside markup. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
