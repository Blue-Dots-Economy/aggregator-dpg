/**
 * CSV header template generator. Produces a single header row in
 * schema-property order (required first, then optional). Aggregators fill
 * in the rest themselves.
 */

import type { JsonSchema } from '@aggregator-dpg/schema-loader/interface';

export function buildCsvTemplate(schema: JsonSchema): string {
  const properties = (schema['properties'] as Record<string, Record<string, unknown>>) ?? {};
  const required = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
  const requiredSet = new Set(required);

  const ordered: string[] = [];
  for (const r of required) {
    if (properties[r]) ordered.push(r);
  }
  for (const name of Object.keys(properties)) {
    if (!requiredSet.has(name)) ordered.push(name);
  }

  return ordered.map(escapeCsvCell).join(',') + '\n';
}

function escapeCsvCell(value: string): string {
  if (value === '') return '';
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
