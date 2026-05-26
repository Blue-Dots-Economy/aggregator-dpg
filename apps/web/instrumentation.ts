/**
 * Next.js OTel entry point.
 *
 * Invoked once when the server boots — earlier than any route module.
 * Guards against double-boot under HMR via the @aggregator-dpg/telemetry
 * idempotency check.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { bootWebTelemetry } = await import('./src/lib/telemetry.js');
  await bootWebTelemetry();
}
