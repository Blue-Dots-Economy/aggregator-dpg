/**
 * Phone-number normalisation. Coarse-grained for MVP — strips spaces and
 * non-digit characters except a single leading `+`, and prefixes `+91` when
 * the input is exactly 10 digits (default region: India).
 *
 * Replace with libphonenumber-js if richer validation is required (it is
 * already pulled in by the Keycloak plugin, but kept out of the API service
 * for now to limit deps).
 */

export interface PhoneNormaliseOk {
  ok: true;
  value: string;
}

export interface PhoneNormaliseError {
  ok: false;
  error: { message: string };
}

export type PhoneNormaliseResult = PhoneNormaliseOk | PhoneNormaliseError;

/**
 * Normalises a phone number to a canonical form that other code can index
 * on. Returns an error result for clearly invalid input rather than throwing.
 *
 * @param raw - User-supplied phone string.
 * @returns `{ok: true, value}` or `{ok: false, error}`.
 */
export function normalisePhone(raw: string): PhoneNormaliseResult {
  if (!raw) return { ok: false, error: { message: 'phone is empty' } };
  const trimmed = raw.trim();
  // keep optional leading + and digits only
  const cleaned = trimmed.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) {
    const digits = cleaned.slice(1);
    if (digits.length < 10 || digits.length > 15) {
      return {
        ok: false,
        error: { message: 'phone must have 10–15 digits after country code' },
      };
    }
    return { ok: true, value: `+${digits}` };
  }
  // bare digits — assume India default region if exactly 10 digits
  if (cleaned.length === 10) {
    return { ok: true, value: `+91${cleaned}` };
  }
  if (cleaned.length >= 11 && cleaned.length <= 15) {
    return { ok: true, value: `+${cleaned}` };
  }
  return {
    ok: false,
    error: { message: `phone has ${cleaned.length} digits; expected 10–15` },
  };
}
