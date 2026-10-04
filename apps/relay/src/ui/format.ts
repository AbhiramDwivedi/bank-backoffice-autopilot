/**
 * Pure formatting helpers shared by every view. No DOM access, no store access: given data in,
 * text out, so they are trivial to eyeball and reuse.
 */
import type { CapturedAction, FrameHop, InterventionDto } from '../shared/api.js';

/** "12s", "4m", "1h 5m", "2d". Never negative (clamps to 0). */
export function formatAge(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const remMinutes = totalMinutes % 60;
    return remMinutes > 0 ? `${totalHours}h ${remMinutes}m` : `${totalHours}h`;
  }
  const totalDays = Math.floor(totalHours / 24);
  return `${totalDays}d`;
}

/** HH:MM:SS, 24 h, local time. */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** "m:ss", or "h:mm:ss" over an hour. "0:00" once `ms` is at or below zero. */
export function formatCountdown(ms: number): string {
  const totalSeconds = ms > 0 ? Math.floor(ms / 1000) : 0;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/** "run_…abcd1234": keeps a recognizable prefix and the tail, drops the noisy middle. */
export function shortRunId(id: string): string {
  const match = /^[A-Za-z]+_/.exec(id);
  const prefix = match ? match[0] : '';
  const rest = id.slice(prefix.length);
  if (rest.length <= 8) return id;
  return `${prefix}…${rest.slice(-8)}`;
}

/** "Top frame" for the top document; otherwise the hop chain, most identifying name first. */
export function frameLabel(frame: readonly FrameHop[]): string {
  if (frame.length === 0) return 'Top frame';
  return frame.map((hop, i) => hop.name ?? hop.urlPattern ?? `#${hop.index ?? i}`).join(' › ');
}

/** Describes what a captured action targeted. Never reads `target.text` (redaction, defense in depth). */
export function actionTargetLabel(action: CapturedAction): string {
  const t = action.target;
  if (t.role !== undefined && t.name !== undefined) return `${t.role} "${t.name}"`;
  if (t.role !== undefined) return t.role;
  if (t.tag !== undefined && t.selector !== undefined) return `${t.tag} ${t.selector}`;
  if (t.tag !== undefined) return t.tag;
  if (t.selector !== undefined) return t.selector;
  return 'page';
}

/** The title an operator recognizes: capability id for a replay, goal for a discovery. */
export function titleOf(dto: Pick<InterventionDto, 'capabilityId' | 'goal'>): string {
  return dto.capabilityId ?? dto.goal ?? 'Untitled intervention';
}
