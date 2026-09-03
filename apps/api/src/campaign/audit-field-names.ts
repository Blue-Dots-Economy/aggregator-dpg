/**
 * Audit-boundary sanitiser for caller-supplied field NAMES (aggregator-dpg#617,
 * fix-round-1 + fix-round-2).
 *
 * `campaign-voice.ts`'s `piiFields` releases the fixed `name`/`phone` pair
 * plus whatever extra `item_state` field names the caller listed in
 * `content.variables` — see `apps/worker/.../campaign-process/voice.ts`'s
 * `decryptVoiceItems` doc comment: these are a field-NAME projection (the
 * `fields` query param on the decrypt call), not participant values, so
 * recording them on the `requested` audit row is the right call semantically.
 *
 * The defect fix-round-1 fixes: nothing constrained `content.variables` to
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
 * The defect fix-round-2 fixes: the shape filter alone bounds neither the
 * length of an individual entry nor how many entries land on one row. A
 * shape-valid but absurd input (e.g. a single multi-kilobyte token, or
 * thousands of one-letter names) still rode straight into `pii_fields`
 * unbounded — not a PII leak (the shape filter still holds), but it lets an
 * authenticated coordinator drive unbounded content into a compliance table
 * whose value depends on staying queryable. {@link MAX_FIELD_NAME_LENGTH} and
 * {@link MAX_FIELD_NAME_COUNT} close that.
 *
 * This is the boundary that enforces both contracts for this one input:
 * {@link sanitizeAuditFieldNames} keeps only identifier-shaped strings within
 * a per-entry length bound, caps how many are recorded, and reports counts
 * for everything it dropped and why — so the row stays truthful about how
 * many fields were released without ever copying the free-text value itself,
 * or an unbounded number/size of names, into the table. The caller's own
 * `content.variables` value is untouched — this only affects what gets
 * copied onto the audit row.
 *
 * Deliberately permissive, not a schema: this never rejects a request — a
 * false negative here (a genuine field name that happens not to match, or is
 * dropped for being the 51st) only costs a slightly less precise audit row,
 * never blocks the call to Raya. The unfiltered `variables` array still
 * reaches `decryptVoiceItems` unchanged; only the audit copy is filtered.
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

/**
 * Maximum length, in characters, of a single `content.variables` entry
 * recorded verbatim on an audit row (#617 fix-round-2). 64 is chosen because
 * it is nowhere near the longest real `item_state` key in this repo (e.g.
 * `signalstack_org_id` is 19 characters) — any shape-valid candidate this
 * long is self-evidently not a field name, so rejecting it costs nothing on
 * genuine input while bounding how much text one entry can smuggle into
 * `pii_fields`. It also narrows the residual noted in the module doc: a
 * `min(1)`-only string like a participant's actual name is indistinguishable
 * from a field name by shape alone, but a multi-kilobyte one no longer is.
 */
export const MAX_FIELD_NAME_LENGTH = 64;

/**
 * Maximum number of `content.variables` entries recorded on one audit row
 * (#617 fix-round-2). Matches `envelope.ts`'s `campaignMetadataPairSchema`
 * array cap (`.max(50)`) so every caller-controlled array that feeds
 * `campaign_pii_audit` shares one ceiling, rather than each boundary
 * inventing its own number.
 */
export const MAX_FIELD_NAME_COUNT = 50;

/** Result of {@link sanitizeAuditFieldNames}. */
export interface SanitizedAuditFieldNames {
  /**
   * The subset of the input that is identifier-shaped, at most
   * {@link MAX_FIELD_NAME_LENGTH} characters, and within the first
   * {@link MAX_FIELD_NAME_COUNT} such entries — in original order.
   */
  names: string[];
  /** How many input entries were dropped for not looking like a field name. */
  droppedCount: number;
  /**
   * How many otherwise identifier-shaped entries were dropped for exceeding
   * {@link MAX_FIELD_NAME_LENGTH}. Counted separately from
   * {@link droppedCount}: a long candidate is not "not an identifier" — it
   * failed a different, size-based rule, and the row should say so.
   */
  tooLongCount: number;
  /**
   * How many identifier-shaped, in-length entries were dropped only because
   * {@link MAX_FIELD_NAME_COUNT} was already reached. Counted separately from
   * {@link droppedCount}: the 51st valid name is not a non-identifier either.
   */
  overLimitCount: number;
}

/**
 * Filters caller-supplied strings down to the identifier-shaped ones, bounds
 * each to {@link MAX_FIELD_NAME_LENGTH} characters, and caps the result at
 * {@link MAX_FIELD_NAME_COUNT} entries — for recording as audit `piiFields`
 * entries. See the module doc for why this boundary exists and what it does
 * and does not protect.
 *
 * Entries are classified in this order, each into its own count so the
 * result stays a truthful account of what was dropped and why: shape first
 * (not identifier-shaped → {@link SanitizedAuditFieldNames.droppedCount}),
 * then length (identifier-shaped but too long →
 * {@link SanitizedAuditFieldNames.tooLongCount}), then count (identifier-shaped
 * and in-length, but the cap was already reached →
 * {@link SanitizedAuditFieldNames.overLimitCount}).
 *
 * @param candidates - Raw strings from a caller-controlled field, exactly as
 *   sent (e.g. `content.variables`). Never mutated.
 * @returns The identifier-shaped, length- and count-bounded subset, plus a
 *   count of everything dropped, broken out by reason.
 */
export function sanitizeAuditFieldNames(candidates: readonly string[]): SanitizedAuditFieldNames {
  const names: string[] = [];
  let droppedCount = 0;
  let tooLongCount = 0;
  let overLimitCount = 0;

  for (const candidate of candidates) {
    if (!FIELD_NAME_PATTERN.test(candidate)) {
      droppedCount++;
    } else if (candidate.length > MAX_FIELD_NAME_LENGTH) {
      tooLongCount++;
    } else if (names.length >= MAX_FIELD_NAME_COUNT) {
      overLimitCount++;
    } else {
      names.push(candidate);
    }
  }

  return { names, droppedCount, tooLongCount, overLimitCount };
}

/**
 * Builds the extra `piiFields` entries for a set of caller-supplied field-name
 * candidates: the identifier-shaped, length- and count-bounded names
 * verbatim, plus one summary entry per drop reason (never a value, and never
 * folding one reason into another's count — see
 * {@link sanitizeAuditFieldNames}) so the row still reflects that those
 * fields were released even though not every literal name was safe, or
 * possible, to record.
 *
 * @param candidates - Raw strings from a caller-controlled field (e.g.
 *   `content.variables`).
 * @returns Entries to append to a channel's `piiFields` array.
 */
export function auditFieldNameEntries(candidates: readonly string[]): string[] {
  const { names, droppedCount, tooLongCount, overLimitCount } = sanitizeAuditFieldNames(candidates);
  const summaries: string[] = [];
  if (droppedCount > 0) summaries.push(`+${droppedCount} redacted (non-identifier)`);
  if (tooLongCount > 0) summaries.push(`+${tooLongCount} redacted (too long)`);
  if (overLimitCount > 0) summaries.push(`+${overLimitCount} redacted (over limit)`);
  return [...names, ...summaries];
}
