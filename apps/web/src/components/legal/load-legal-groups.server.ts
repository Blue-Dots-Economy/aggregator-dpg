/**
 * Assembles the audience groups `/legal` needs for its contents rail: the
 * aggregator's own operator policy, and the organisation one.
 *
 * **No participant group.** A participant never registers through this portal
 * — they register through a public QR form, which shows them their own
 * documents inline in its consent gate, and their standing copy lives in the
 * Signals portal. Publishing the participant documents here as well meant a
 * page that mixed two unrelated audiences, and (once `/legal` became the one
 * page) that the FIRST group a reader met was for people who never visit.
 *
 * The two remaining audiences load from one config call, and a failure returns
 * an empty list rather than throwing: a config problem must render a message,
 * not a stack trace.
 *
 * @module apps/web/src/components/legal/load-legal-groups.server
 */
import 'server-only';
import { getTranslations } from 'next-intl/server';
import { loadConsentConfig } from '@aggregator-dpg/config-loader/fs';
import { logger } from '../../lib/logger';
import type { ConsentDocContent } from '../consent/consent-types';
import type { LegalGroup } from './LegalDocumentView';

/** Shape of one versioned document inside `loadConsentConfig`'s result. */
interface AudienceDoc {
  current_version: number;
  versions: Array<{ version: number; title: string; content: string; effective_from: string }>;
}

/**
 * Picks the current-version entry of an aggregator/org consent document.
 *
 * @throws if `current_version` has no matching entry — the caller catches
 *   this alongside every other `loadConsentConfig` failure.
 */
function pickCurrent(doc: AudienceDoc): ConsentDocContent['terms'] {
  const found = doc.versions.find((v) => v.version === doc.current_version);
  if (!found) throw new Error(`current_version ${doc.current_version} not found in versions`);
  return {
    version: found.version,
    title: found.title,
    content: found.content,
    effective_from: found.effective_from,
  };
}

/**
 * Loads the aggregator + org audience groups from the aggregator's own
 * `consent.json` (a single config file covers both audiences). Returns an
 * empty list — rather than throwing — when the network/brand config is
 * missing or invalid, so a config problem on this side never removes the
 * participant group.
 */
async function loadAggregatorOrgGroups(labels: {
  aggregator: string;
  org: string;
}): Promise<LegalGroup[]> {
  const network = process.env.AGGREGATOR_NETWORK?.trim() || 'blue_dot';
  const brand = process.env.AGGREGATOR_BRAND?.trim() || undefined;
  try {
    const cfg = await loadConsentConfig(network, brand);
    return [
      {
        audience: 'aggregator',
        label: labels.aggregator,
        content: {
          terms: pickCurrent(cfg.audiences.aggregator.documents.terms),
          privacy: pickCurrent(cfg.audiences.aggregator.documents.privacy),
        },
      },
      {
        audience: 'org',
        label: labels.org,
        content: {
          terms: pickCurrent(cfg.audiences.org.documents.terms),
          privacy: pickCurrent(cfg.audiences.org.documents.privacy),
        },
      },
    ];
  } catch (err) {
    logger.warn({
      operation: 'loadLegalGroups',
      audience: 'aggregator+org',
      status: 'failure',
      error: err instanceof Error ? err.message : String(err),
      network,
      brand,
    });
    return [];
  }
}

/**
 * Loads the operator audiences' consent content for `/legal`, in aggregator →
 * org order.
 *
 * @returns Both audiences, or an empty list when the config failed to load
 *   (the view then renders a `role="status"` message instead of a blank page).
 */
export async function loadLegalGroups(): Promise<LegalGroup[]> {
  const t = await getTranslations('legal');
  return loadAggregatorOrgGroups({
    aggregator: t('audience_aggregator'),
    org: t('audience_org'),
  });
}
