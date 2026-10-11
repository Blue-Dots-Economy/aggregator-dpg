/**
 * The `item_state` block sent to signalstack for a participant's profile.
 *
 * Shared by the two onboarding paths — the bulk-upload worker and the public
 * registration-link route — which previously each carried an identical copy.
 *
 * @module @aggregator-dpg/signalstack-writer/item-state
 */

/**
 * Builds the profile `item_state` from a submitted row or form body.
 *
 * Aggregator participant schemas use the same field names as signalstack's
 * profile item_state, so the body flows through unchanged. The one exception is
 * the phone field: signalstack validates it against the network's own pattern
 * (purple_dot expects `^[0-9]{10}$`, blue_dot expects E.164), so the raw value
 * the participant submitted is kept, and the normalised phone is only filled in
 * when the body had no value at all. The E.164 form travels separately as the
 * `user.phone_number` identity argument either way.
 *
 * @param body - The submitted row / form fields.
 * @param pushPhone - The normalised phone resolved for this participant, if any.
 * @param phoneField - The profile field holding the phone (the domain's
 *   identity selector, e.g. `mobile_number`).
 * @returns A new object; `body` is not mutated.
 */
export function buildSignalStackItemState(
  body: Record<string, unknown>,
  pushPhone: string | null,
  phoneField: string,
): Record<string, unknown> {
  const itemState: Record<string, unknown> = { ...body };
  const rawPhone = body[phoneField];
  if (pushPhone && (typeof rawPhone !== 'string' || rawPhone.length === 0)) {
    itemState[phoneField] = pushPhone;
  }
  return itemState;
}
