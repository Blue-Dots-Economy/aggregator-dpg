/**
 * Per-call timeout for the operator commands in `@aggregator-dpg/api`
 * (bulk upload, QR links), so a hung store or queue call cannot stall a run.
 */

/** A call that did not finish within the per-call timeout; whether it took effect is unknown. */
export class CallTimeout extends Error {}

/**
 * Rejects when `promise` takes longer than `ms`. The call itself is not
 * cancelled and may still complete.
 *
 * @param what - Names the call in the error message; no row data.
 * @throws {CallTimeout} When the time runs out.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CallTimeout(`${what} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
