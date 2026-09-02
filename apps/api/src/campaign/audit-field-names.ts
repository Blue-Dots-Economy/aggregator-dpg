/**
 * Audit-boundary sanitiser for caller-supplied field NAMES (aggregator-dpg#617,
 * fix-round-1).
 *
 * `campaign-voice.ts`'s `piiFields` releases the fixed `name`/`phone` pair
 * plus whatever extra `item_state` field names the caller listed in
 * `content.variables` — see `apps/worker/.../campaign-process/voice.ts`'s
 * `decryptVoiceItems` doc comment: these are a field-NAME projection (the
 * `fields` query param on the decrypt call), not participant values, so
 * recording them on the `requested` audit row is the right call semantically.
 *
 * The defect this module fixes: nothing constrained `content.variables` to
 * actually look like field names. `voiceContentSchema` intentionally leaves
 * it as `z.array(z.string().min(1))` — free text — because tightening THAT
 * schema would be a user-visible API change (what the voice route accepts,
 * and what the worker forwards to Raya) and is a separate decision from this
 * one. So a caller could, deliberately or by mistake, put a participant's
 * actual name/email/phone in `variables`, and it would ride straight into
 * `campaign_pii_audit` — violating `CampaignAuditWriterBase`'s own contract:
 * "NEVER pass a participant PII value into any of these inputs. Field NAMES
 * and counts only."
 *
 * This is the boundary that actually enforces that contract for this one
 * input: {@link sanitizeAuditFieldNames} keeps only identifier-shaped
 * strings (the caller's own `content.variables` value is untouched — this
 * only affects what gets copied onto the audit row) and reports how many
 * entries were dropped, so the row stays truthful about how many fields were
 * released without ever copying the free-text value itself into the table.
 *
 * Deliberately permissive, not a schema: this never rejects a request — a
 * false negative here (a genuine field name that happens not to match) only
 * costs a slightly less precise audit row, never blocks the call to Raya.
 * The unfiltered `variables` array still reaches `decryptVoiceItems`
 * unchanged; only the audit copy is filtered.
 *
 * @module @aggregator-dpg/api
 */

/**
 * A field-NAME shape: letters/digits/underscore, starting with a letter or
 * underscore — matches every real `item_state` key used in this codebase
 * (e.g. `role`, `signalstack_org_id`) and rejects the punctuation a
 * participant value typically carries (a space in a name, an `@` in an
 * email, `+`/digits-with-punctuation in a phone number). Not a general
 * identifier grammar (no dots, no leading digits) — kept narrow on purpose
 * so it stays easy to reason about at this boundary.
 */
const FIELD_NAME_PATTERN = /^[A-Za-z_]\w*$/;

/** Result of {@link sanitizeAuditFieldNames}. */
export interface SanitizedAuditFieldNames {
  /** The subset of the input that is identifier-shaped, in original order. */
  names: string[];
  /** How many input entries were dropped for not looking like a field name. */
  droppedCount: number;
}

/**
 * Filters caller-supplied strings down to the identifier-shaped ones, for
 * recording as audit `piiFields` entries — see the module doc for why this
 * boundary exists and what it does and does not protect.
 *
 * @param candidates - Raw strings from a caller-controlled field, exactly as
 *   sent (e.g. `content.variables`). Never mutated.
 * @returns The identifier-shaped subset, plus a count of everything dropped.
 */
export function sanitizeAuditFieldNames(candidates: readonly string[]): SanitizedAuditFieldNames {
  const names = candidates.filter((c) => FIELD_NAME_PATTERN.test(c));
  return { names, droppedCount: candidates.length - names.length };
}

/**
 * Builds the extra `piiFields` entries for a set of caller-supplied field-name
 * candidates: the identifier-shaped names verbatim, plus one summary entry
 * (never a value) when any were dropped, so the row still reflects that
 * those fields were released even though their literal names weren't safe to
 * record.
 *
 * @param candidates - Raw strings from a caller-controlled field (e.g.
 *   `content.variables`).
 * @returns Entries to append to a channel's `piiFields` array.
 */
export function auditFieldNameEntries(candidates: readonly string[]): string[] {
  const { names, droppedCount } = sanitizeAuditFieldNames(candidates);
  return droppedCount > 0 ? [...names, `+${droppedCount} redacted (non-identifier)`] : names;
}
