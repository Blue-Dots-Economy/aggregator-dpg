'use client';

/**
 * Dashboard shell with the top bar and the coordinator's domain tab (`web` app).
 */
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Topbar } from '@/components/shell/Topbar';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '@/hooks/useAggregatorConfig';
import { I } from '@/icons';
import { useCan } from '@/lib/auth-context';
import { ProvidersTab } from './ProvidersTab';
import { SeekersTab } from './SeekersTab';

/** Subtitle when the brand has no tagline. */
const DEFAULT_SUBTITLE = 'Track every participant in your network — at a glance.';

/** Item types starting with this prefix are shown with the provider view. */
const PROVIDER_ITEM_TYPE_PREFIX = 'job_posting';

/** Props for {@link DashboardContent}. */
export interface DashboardContentProps {
  /** The coordinator's `aggregator_type`, which is its domain id. */
  aggregatorType: string;
}

/** Top bar title from the brand's short name. */
export function dashboardTitle(shortName: string): string {
  return `My ${shortName}`;
}

/** Top bar shown while the profile loads. */
export function DashboardLoadingFrame() {
  const t = useTranslations('dashboard');
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  return (
    <div className="fade-up">
      <Topbar
        title={dashboardTitle(cfg.brand.short_name)}
        subtitle={cfg.brand.tagline ?? DEFAULT_SUBTITLE}
      />
      <div className="text-center text-[13px] text-ink-400 py-12">{t('state.loading')}</div>
    </div>
  );
}

/** Props for {@link DashboardErrorFrame}. */
export interface DashboardErrorFrameProps {
  /** Reads the profile again. */
  onRetry: () => void;
}

/** Top bar with an error and a retry, shown when the profile cannot be read. */
export function DashboardErrorFrame({ onRetry }: DashboardErrorFrameProps) {
  const t = useTranslations('dashboard');
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  return (
    <div className="fade-up">
      <Topbar
        title={dashboardTitle(cfg.brand.short_name)}
        subtitle={cfg.brand.tagline ?? DEFAULT_SUBTITLE}
      />
      <div className="flex flex-col items-center gap-3 py-12">
        <div role="alert" className="text-[13px] text-rose-600">
          {t('state.failedToLoad')}
        </div>
        <Button kind="ghost" icon={<I.refresh size={14} />} onClick={onRetry}>
          {t('buttons.retry')}
        </Button>
      </div>
    </div>
  );
}

/**
 * The dashboard for the coordinator's own domain.
 *
 * There is no tab strip: the domain is fixed by the aggregator's type.
 */
export function DashboardContent({ aggregatorType }: DashboardContentProps) {
  const router = useRouter();
  const t = useTranslations('dashboard');
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  // Undefined when no config entry matches, which skips the dashboard read.
  const primaryDomainCfg = cfg.domains?.find((d) => d.id === aggregatorType);
  const primaryDomain = primaryDomainCfg?.id;
  const isProviderLike = (primaryDomainCfg?.item_type ?? '').startsWith(PROVIDER_ITEM_TYPE_PREFIX);
  const canOnboard = useCan()('profiles.onboard');

  return (
    <div className="fade-up">
      <Topbar
        title={dashboardTitle(cfg.brand.short_name)}
        subtitle={cfg.brand.tagline ?? DEFAULT_SUBTITLE}
        right={
          <div className="flex items-center gap-2">
            {canOnboard && (
              <Button icon={<I.plus size={14} />} onClick={() => router.push('/onboarding')}>
                {t('buttons.addParticipants')}
              </Button>
            )}
          </div>
        }
      />
      {isProviderLike ? (
        <ProvidersTab domainId={primaryDomain} />
      ) : (
        <SeekersTab domainId={primaryDomain} />
      )}
    </div>
  );
}
