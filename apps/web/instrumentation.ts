/**
 * Next.js OTel entry point.
 *
 * Invoked once when the server boots — earlier than any route module.
 * Guards against double-boot under HMR via the @aggregator-dpg/telemetry
 * idempotency check. Also wires SIGTERM/SIGINT to flush the OTel BSP
 * buffer before process exit so the last batch isn't lost on rolling
 * restart.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { bootWebTelemetry, shutdownWebTelemetry } = await import('./src/lib/telemetry.js');
  await bootWebTelemetry();

  const flushAndExit = (signal: string) => async (): Promise<void> => {
    console.log(`[web] ${signal} — flushing telemetry`);
    try {
      await shutdownWebTelemetry();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGTERM', () => void flushAndExit('SIGTERM')());
  process.once('SIGINT', () => void flushAndExit('SIGINT')());
}
