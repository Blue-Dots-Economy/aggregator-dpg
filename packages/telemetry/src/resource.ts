/**
 * OTel Resource builder for @aggregator-dpg/telemetry.
 *
 * Constructs an OpenTelemetry Resource that identifies the service emitting
 * telemetry — name, namespace, version, instance id, deployment environment,
 * and the DPG-specific block label — per the attribute schema in
 * docs/telemetry-design.md §3 "Resource attributes per block".
 *
 * @module @aggregator-dpg/telemetry/resource
 */

import { randomUUID } from 'node:crypto';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes as ATTR } from '@opentelemetry/semantic-conventions';

/**
 * Maps the well-known aggregator service names to their short DPG block labels.
 *
 * Any service name not in this map falls back to the full service name as the
 * block label so that unknown services still emit a meaningful `dpg.block`.
 */
const BLOCK_BY_SERVICE: Record<string, string> = {
  'aggregator-api': 'api',
  'aggregator-worker': 'worker',
  'aggregator-web': 'web',
  'aggregator-observability-svc': 'observability-svc',
};

/**
 * Options required to build an OTel Resource for a DPG aggregator service.
 */
export interface ResourceOptions {
  /**
   * Human-readable service name (e.g. `aggregator-api`).
   * Used as `service.name` and to derive `dpg.block`.
   */
  serviceName: string;

  /**
   * SemVer string for the deployed artifact (e.g. `1.2.3`).
   * Reported as `service.version`.
   */
  serviceVersion: string;

  /**
   * Deployment environment label (e.g. `dev`, `staging`, `prod`).
   * Reported as `deployment.environment`.
   */
  deploymentEnvironment: string;
}

/**
 * Builds the OTel Resource that identifies this service instance.
 *
 * Sets the following attributes on the returned Resource:
 * - `service.name` — from `opts.serviceName`
 * - `service.namespace` — always `'aggregator'`
 * - `service.version` — from `opts.serviceVersion`
 * - `service.instance.id` — `process.env.HOSTNAME` when set (Kubernetes pod
 *   name), otherwise a freshly-generated UUID. Critical for disambiguating
 *   multiple replicas in the same time-series backend.
 * - `deployment.environment` — from `opts.deploymentEnvironment`
 * - `dpg.block` — short block label derived from the service name
 *   (e.g. `aggregator-api` → `api`).
 *
 * @param opts - Service identity options.
 * @returns An OTel {@link Resource} populated with all required DPG attributes.
 */
export function buildResource(opts: ResourceOptions): Resource {
  const block = BLOCK_BY_SERVICE[opts.serviceName] ?? opts.serviceName;
  const instanceId = process.env.HOSTNAME ?? randomUUID();
  return new Resource({
    [ATTR.SERVICE_NAME]: opts.serviceName,
    [ATTR.SERVICE_NAMESPACE]: 'aggregator',
    [ATTR.SERVICE_VERSION]: opts.serviceVersion,
    [ATTR.SERVICE_INSTANCE_ID]: instanceId,
    [ATTR.DEPLOYMENT_ENVIRONMENT]: opts.deploymentEnvironment,
    'dpg.block': block,
  });
}
