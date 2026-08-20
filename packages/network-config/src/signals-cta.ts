/**
 * The one `signals_cta` default rule, shared by both runtimes.
 *
 * `signals_cta` is optional in the aggregator YAML (see
 * `RegistrationModeSchema` in `./interface`). When a mode omits it the flag
 * defaults off the mode's submission shape — the Signals hand-off appears on
 * full-profile links only. That default used to be written twice: once in the
 * api (`services/registration-mode`, which bakes the resolved boolean onto the
 * `/v1/aggregator-config` wire payload) and once in the web app
 * (`SignalsSignInCta`, which re-derives it as a back-compat fallback for an
 * older api build that does not send the field). Two copies of one rule drift;
 * this module is the single copy both import.
 *
 * Deliberately dependency-free — no zod, no Node built-ins, nothing from
 * `./interface`. The web app pulls this into the *client* bundle and must not
 * drag the runtime YAML schemas along with it (see the note on the duplicated
 * brand types in `apps/web/src/hooks/useAggregatorConfig.ts`). Keep it that
 * way: this file may never grow an import.
 *
 * @module @aggregator-dpg/network-config/signals-cta
 */

/** How much a registration link captures. Mirrors `submission_shape` in the YAML. */
export type SubmissionShape = 'account_only' | 'account_and_profile';

/**
 * Resolve a registration mode's effective `signals_cta` flag.
 *
 * @param explicit - The mode's declared `signals_cta`, or `undefined` when the
 *   config omits it (or when the value did not reach this runtime at all — an
 *   older api build that predates the field on the wire).
 * @param submissionShape - The mode's *resolved* submission shape. Callers pass
 *   the shape they would actually render, not the raw YAML value, so an
 *   undeclared mode — which already falls back to the full profile form —
 *   behaves like a full-profile mode here too.
 * @returns `explicit` when it is a boolean, otherwise the default: on for
 *   full-profile links, off for identity-only links.
 */
export function resolveSignalsCta(
  explicit: boolean | undefined,
  submissionShape: SubmissionShape,
): boolean {
  if (typeof explicit === 'boolean') return explicit;
  return submissionShape === 'account_and_profile';
}
