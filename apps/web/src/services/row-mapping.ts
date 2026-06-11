import type { DirectionalStats } from '../types';

/**
 * Coerces a signalstack directional action map (`initiated` / `received` on a
 * dashboard item) into a complete {@link DirectionalStats}, defaulting every
 * missing bucket to 0.
 *
 * @param raw - The directional map from a dashboard item, or undefined.
 * @returns A fully-populated directional stats object.
 */
export function mapDirectional(raw: unknown): DirectionalStats {
  const m = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return {
    create: num(m.create),
    accept: num(m.accept),
    reject: num(m.reject),
    cancel: num(m.cancel),
  };
}
