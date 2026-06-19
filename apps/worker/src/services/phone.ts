/**
 * Phone normalisation. Copied from apps/api/src/services/phone.ts to avoid
 * pulling the API as a dep. Promote to a shared package once a third
 * consumer needs it.
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

export function normalisePhone(raw: string): PhoneNormaliseResult {
  if (!raw) return { ok: false, error: { message: 'phone is empty' } };
  const trimmed = raw.trim();
  const cleaned = trimmed.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) {
    const digits = cleaned.slice(1);
    if (digits.length < 10 || digits.length > 15) {
      return {
        ok: false,
        error: { message: 'phone must have 10-15 digits after country code' },
      };
    }
    return { ok: true, value: `+${digits}` };
  }
  if (cleaned.length === 10) {
    return { ok: true, value: `+91${cleaned}` };
  }
  if (cleaned.length >= 11 && cleaned.length <= 15) {
    return { ok: true, value: `+${cleaned}` };
  }
  return {
    ok: false,
    error: { message: `phone has ${cleaned.length} digits; expected 10-15` },
  };
}

export function normaliseEmail(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return trimmed.toLowerCase();
}
