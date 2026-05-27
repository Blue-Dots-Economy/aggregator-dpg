import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: false,
  // OTel SDK packages must be required at runtime (Node), not bundled by
  // webpack — they're large, pull in dynamic native deps, and the OTel
  // instrumentations rely on patching modules at require time.
  serverExternalPackages: [
    '@aggregator-dpg/telemetry',
    '@opentelemetry/api',
    '@opentelemetry/api-logs',
    '@opentelemetry/core',
    '@opentelemetry/exporter-logs-otlp-grpc',
    '@opentelemetry/exporter-metrics-otlp-grpc',
    '@opentelemetry/exporter-trace-otlp-grpc',
    '@opentelemetry/instrumentation',
    '@opentelemetry/instrumentation-fastify',
    '@opentelemetry/instrumentation-undici',
    '@opentelemetry/propagator-b3',
    '@opentelemetry/resources',
    '@opentelemetry/sdk-logs',
    '@opentelemetry/sdk-metrics',
    '@opentelemetry/sdk-node',
    '@opentelemetry/sdk-trace-base',
    '@opentelemetry/semantic-conventions',
    'pino',
    'pino-abstract-transport',
    'pino-pretty',
  ],
};

export default nextConfig;
