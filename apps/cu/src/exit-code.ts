/**
 * ReplayResult -> process exit code mapping shared by `replay` and `catalog invoke`. A crash
 * (thrown error outside replayCapability's own try/catch, e.g. a bad artifact file) is 1 and
 * handled separately at the top level.
 */
import type { ReplayResult } from '@cu/core/schema';

export const CRASH_EXIT_CODE = 1;

/** Maps a `ReplayResult`'s kind to the CLI's process exit code: success 0, business_outcome 3,
 *  hard_failure 4, escalated 5 (regardless of `resolution`). */
export function exitCodeForResult(result: ReplayResult): number {
  switch (result.kind) {
    case 'success':
      return 0;
    case 'business_outcome':
      return 3;
    case 'hard_failure':
      return 4;
    case 'escalated':
      return 5;
  }
}
