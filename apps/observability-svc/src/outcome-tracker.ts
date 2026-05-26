/**
 * Maps incoming outcome events to declarative OTel metric increments.
 *
 * Metric definitions come from `OUTCOME_METRICS_JSON` (validated in
 * config.ts). Each definition has a `name`, an `instrument` kind, an
 * optional `on_event` filter, and an `attributes` array listing the
 * fields to copy from the payload into label values.
 *
 * Counters and up-down-counters get `+1`. Histograms record the
 * payload's `value` field (numeric).
 *
 * @module observability-svc/outcome-tracker
 */

import type { Counter, Histogram, Meter, UpDownCounter } from '@opentelemetry/api';
import type { OutcomeMetricDef } from './config.js';

type Instrument = Counter | Histogram | UpDownCounter;

/** Options for constructing an OutcomeTracker. */
interface TrackerOpts {
  /** The list of metric definitions to register at boot. */
  metrics: OutcomeMetricDef[];
  /** The OTel Meter used to create instruments. */
  meter: Meter;
}

/**
 * Registers OTel instruments from a metric catalogue and routes incoming
 * outcome events to the correct instrument for recording.
 *
 * Each metric definition may declare an `on_event` filter. When present,
 * the metric is only updated when the payload's `event` field matches.
 * Definitions without `on_event` are placed under the wildcard `'*'` key
 * and updated for every event.
 */
export class OutcomeTracker {
  private readonly byEvent = new Map<string, { def: OutcomeMetricDef; inst: Instrument }[]>();

  /**
   * Constructs the tracker and eagerly creates all declared OTel instruments.
   *
   * @param opts - Metric definitions and the OTel Meter to register against.
   */
  constructor(opts: TrackerOpts) {
    for (const def of opts.metrics) {
      const inst = this._makeInstrument(def, opts.meter);
      const key = def.on_event ?? '*';
      const existing = this.byEvent.get(key) ?? [];
      existing.push({ def, inst });
      this.byEvent.set(key, existing);
    }
  }

  /**
   * Creates the appropriate OTel instrument for the given metric definition.
   *
   * @param def - The metric definition specifying name, instrument kind, and optional metadata.
   * @param meter - The OTel Meter to use for instrument creation.
   * @returns The created Counter, Histogram, or UpDownCounter instrument.
   */
  private _makeInstrument(def: OutcomeMetricDef, meter: Meter): Instrument {
    const opts: { description?: string; unit?: string } = {};
    if (def.description !== undefined) opts.description = def.description;
    if (def.unit !== undefined) opts.unit = def.unit;
    switch (def.instrument) {
      case 'counter':
        return meter.createCounter(def.name, opts);
      case 'histogram':
        return meter.createHistogram(def.name, opts);
      case 'updown_counter':
        return meter.createUpDownCounter(def.name, opts);
    }
  }

  /**
   * Routes an outcome event to all matching metric instruments and records the value.
   *
   * Counters and up-down-counters are incremented by 1. Histograms record
   * the numeric `value` field from the payload attributes (defaults to 0 if absent).
   * Only attribute keys declared in the metric definition are forwarded as labels.
   *
   * @param payload - The outcome event containing an event name and attribute map.
   */
  process(payload: { event: string; attributes: Record<string, unknown> }): void {
    const candidates = [
      ...(this.byEvent.get(payload.event) ?? []),
      ...(this.byEvent.get('*') ?? []),
    ];
    for (const { def, inst } of candidates) {
      const labels: Record<string, string> = {};
      for (const k of def.attributes ?? []) {
        if (k in payload.attributes) labels[k] = String(payload.attributes[k]);
      }
      if (def.instrument === 'counter' || def.instrument === 'updown_counter') {
        (inst as Counter).add(1, labels);
      } else {
        const v = Number(payload.attributes['value'] ?? 0);
        (inst as Histogram).record(v, labels);
      }
    }
  }
}
