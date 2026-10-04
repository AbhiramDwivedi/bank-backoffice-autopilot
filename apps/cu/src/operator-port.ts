/**
 * `--operator-port` default resolution for `replay` and `catalog invoke`, the two commands that
 * can run entirely unattended (a scripted `--auto-operator`, headless). `discover` and any
 * `--headed` run keep the well-known `DEFAULT_OPERATOR_PORT` unconditionally -- a human may need
 * to find the console. Only applied when the flag itself was NOT given; an explicit
 * `--operator-port <n>` always wins (see the two commands' own option definitions).
 */
import { DEFAULT_OPERATOR_PORT } from './runtime/index.js';

/** What `resolveOperatorPortDefault` needs to know to pick a default port. */
export interface OperatorPortDefaultContext {
  /** True only when `--headed` was explicitly given (see `globalsOf`: headless defaults to true). */
  headed: boolean;
  /** The resolved `--auto-operator` mode string ('none' | 'approve' | 'abort' | 'relogin'). */
  autoOperator: string;
}

/**
 * `DEFAULT_OPERATOR_PORT` (4300) when a human might need the console -- `--headed` was given, or
 * `--auto-operator` is `'none'` (no scripted operator, so escalations wait on a human). Otherwise
 * `0` (ephemeral): a headless run with a scripted operator attached resolves every escalation
 * itself, so no console needs a predictable, well-known port.
 */
export function resolveOperatorPortDefault(ctx: OperatorPortDefaultContext): number {
  return ctx.headed || ctx.autoOperator === 'none' ? DEFAULT_OPERATOR_PORT : 0;
}
