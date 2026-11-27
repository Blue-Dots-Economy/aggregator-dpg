/**
 * The `item_state` block sent to signalstack for a participant's profile.
 *
 * Used by the bulk-upload worker and the public registration-link route.
 *
 * @module @aggregator-dpg/signalstack-writer/item-state
 */

/**
 * Builds the profile `item_state` from a submitted row or form body.
 *
 * The body is copied unchanged, since the field names match signalstack's
 * item_state, except the phone field, which always carries the cleaned E.164
 * number when there is one. The same number is sent as `user.phone_number`.
 *
 * @param body - The submitted row / form fields.
 * @param pushPhone - The cleaned E.164 phone for this participant, if any.
 * @param phoneField - The profile field holding the phone, e.g. `mobile_number`.
 * @returns A new object; `body` is not mutated.
 */
export function buildSignalStackItemState(
  body: Record<string, unknown>,
  pushPhone: string | null,
  phoneField: string,
): Record<string, unknown> {
  const itemState: Record<string, unknown> = { ...body };
  if (pushPhone) itemState[phoneField] = pushPhone;
  return itemState;
}
