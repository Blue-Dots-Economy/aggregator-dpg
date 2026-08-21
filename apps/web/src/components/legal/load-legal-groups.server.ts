/**
 * Assembles the three audience groups (`participant`, `aggregator`, `org`)
 * `/privacy` and `/terms` need for their contents rail.
 *
 * Each audience is loaded independently — one loader call for participant
 * content, one for the aggregator/org config — so a missing or malformed
 * operator policy can never take down the participant one, and vice versa.
 * An audience whose content fails to load is simply omitted from the
 * returned list rather than throwing.
 *
 * @module apps/web/src/components/legal/load-legal-groups.server
 */
import 'server-only';
import { getTranslations } from 'next-intl/server';
import { loadConsentConfig } from '@aggregator-dpg/config-loader/fs';
import { loadParticipantConsent } from '../../lib/participant-consent.server';
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
 * Loads the participant audience group from the interim Signals-copied
 * `consent.json` (see `participant-consent.server`). Returns `null` when the
 * file is absent or malformed — the page then simply omits this group.
 */
async function loadParticipantGroup(label: string): Promise<LegalGroup | null> {
  try {
    const content = await loadParticipantConsent();
    if (!content) return null;
    return { audience: 'participant', label, content };
  } catch (err) {
    logger.warn({
      operation: 'loadLegalGroups',
      audience: 'participant',
      status: 'failure',
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
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
 * Loads every audience's consent content for the public `/privacy` and
 * `/terms` pages, in participant → aggregator → org order.
 *
 * @returns The audiences whose content loaded successfully; empty when
 *   every audience failed (the view then renders a `role="status"` message
 *   instead of a blank page).
 */
export async function loadLegalGroups(): Promise<LegalGroup[]> {
  const t = await getTranslations('legal');
  const [participant, aggregatorOrg] = await Promise.all([
    loadParticipantGroup(t('audience_participant')),
    loadAggregatorOrgGroups({
      aggregator: t('audience_aggregator'),
      org: t('audience_org'),
    }),
  ]);

  return [...(participant ? [participant] : []), ...aggregatorOrg];
}
