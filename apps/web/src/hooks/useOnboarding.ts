'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  onboardingService,
  type ApiRegistrationLink,
  type BulkUploadList,
  type CreateLinkInput,
  type ListVoiceBotsResponse,
  type OnboardingBySource,
  type OnboardingSummary,
  type UpdateLinkInput,
} from '../services/onboarding.service';

export function useRegistrationLinks(domain: string) {
  return useQuery<ApiRegistrationLink[]>({
    queryKey: ['onboarding', 'links', domain],
    queryFn: async () => {
      const res = await onboardingService.listLinks({ domain });
      return res.items;
    },
    staleTime: 15_000,
  });
}

/** The voice bots a coordinator can attach to a link in `domain`, plus the instance default. */
export function useVoiceBots(domain: string) {
  return useQuery<ListVoiceBotsResponse>({
    queryKey: ['onboarding', 'voice-bots', domain],
    queryFn: () => onboardingService.listVoiceBots(domain),
    staleTime: 60_000,
  });
}

export function useCreateLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLinkInput) => onboardingService.createLink(input),
    onSuccess: (link) => {
      void qc.invalidateQueries({ queryKey: ['onboarding', 'links', link.domain] });
    },
  });
}

export function useUpdateLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateLinkInput }) =>
      onboardingService.updateLink(id, patch),
    onSuccess: (link) => {
      void qc.invalidateQueries({ queryKey: ['onboarding', 'links', link.domain] });
    },
  });
}

export function useActivateLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => onboardingService.activateLink(id),
    onSuccess: (link) => {
      void qc.invalidateQueries({ queryKey: ['onboarding', 'links', link.domain] });
    },
  });
}

export function useDeactivateLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => onboardingService.deactivateLink(id),
    onSuccess: (link) => {
      void qc.invalidateQueries({ queryKey: ['onboarding', 'links', link.domain] });
    },
  });
}

/** Options of the onboarding metrics reads. */
export interface OnboardingMetricsOptions {
  /** Profile type to count; omitted counts every profile type. */
  domain?: string | undefined;
  /** `false` holds the read, e.g. until the active profile type is known. */
  enabled?: boolean;
}

/**
 * Fetches the onboarding totals, for one profile type when `domain` is set.
 *
 * @returns The React Query result for the totals.
 */
export function useOnboardingSummary({ domain, enabled = true }: OnboardingMetricsOptions = {}) {
  return useQuery<OnboardingSummary>({
    queryKey: ['onboarding', 'summary', domain ?? null],
    queryFn: () => onboardingService.summary(domain ? { domain } : {}),
    staleTime: 30_000,
    enabled,
  });
}

/**
 * Fetches onboarding counters grouped by entry source (`bulk` / `link`),
 * for one profile type when `domain` is set.
 *
 * @returns The React Query result for the by-source counters.
 */
export function useOnboardingBySource({ domain, enabled = true }: OnboardingMetricsOptions = {}) {
  return useQuery<OnboardingBySource>({
    queryKey: ['onboarding', 'by-source', domain ?? null],
    queryFn: () => onboardingService.bySource(domain ? { domain } : {}),
    staleTime: 30_000,
    enabled,
  });
}

export function useBulkUpload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      file,
      participantType,
      attestation,
      maxBytes,
    }: {
      file: File;
      participantType: string;
      attestation: boolean;
      maxBytes?: number | undefined;
    }) => onboardingService.uploadCsv(file, participantType, attestation, maxBytes),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['onboarding', 'summary'] });
    },
  });
}

/**
 * Lists the most recent bulk uploads, polling while any is still processing.
 *
 * @param limit - How many recent uploads to fetch.
 * @param domain - When set, keeps only uploads of this participant type. The
 *   filter runs in the browser over one cached list shared by every domain, so
 *   it can return fewer than `limit` items.
 * @returns The react-query result for the upload list.
 */
export function useRecentBulkUploads(limit = 10, domain?: string) {
  return useQuery({
    queryKey: ['onboarding', 'bulk-uploads', 'list', limit],
    queryFn: () => onboardingService.listBulkUploads({ limit }),
    // Filtered after the fetch, so every domain shares one cached list.
    select: (list: BulkUploadList) =>
      domain ? { ...list, items: list.items.filter((it) => it.participant_type === domain) } : list,
    refetchInterval: (q) => {
      const items = q.state.data?.items ?? [];
      const inFlight = items.some((it) =>
        ['uploaded', 'file_validating', 'row_processing', 'finalising'].includes(it.status),
      );
      return inFlight ? 3000 : false;
    },
    staleTime: 5_000,
  });
}
