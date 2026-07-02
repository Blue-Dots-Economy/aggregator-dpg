'use client';

import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { BlueDotsLogo } from '../../../components/ui/BlueDotsLogo';
import { BrandPanel } from '../../../components/login/BrandPanel';
import { I } from '../../../icons';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '../../../hooks/useAggregatorConfig';

export interface LoginViewProps {
  returnTo: string;
  error: string | null;
}

/**
 * Public login page.
 *
 * Two cards:
 *   - "Existing user — Sign in"  → BFF login → Keycloak
 *   - "Become a member"          → /register page (RJSF-driven form)
 *
 * No credentials are collected on this page.
 */
export function LoginView({ returnTo, error }: LoginViewProps): JSX.Element {
  const t = useTranslations('auth');
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  const brand = cfg.brand.short_name;
  const goSignIn = (): void => {
    window.location.href = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
  };
  const goRegister = (): void => {
    window.location.href = '/register';
  };

  return (
    <div className="h-screen w-full flex overflow-hidden">
      <BrandPanel />

      <div
        className="flex-1 min-w-0 h-screen flex items-center justify-center px-6 py-8 relative overflow-y-auto"
        style={{ background: '#FBFCFE' }}
      >
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none opacity-[0.55]"
          style={{
            backgroundImage: 'radial-gradient(rgba(37,99,235,0.07) 1px, transparent 1px)',
            backgroundSize: '22px 22px',
            maskImage: 'radial-gradient(ellipse 80% 70% at 50% 40%, #000 30%, transparent 80%)',
            WebkitMaskImage:
              'radial-gradient(ellipse 80% 70% at 50% 40%, #000 30%, transparent 80%)',
          }}
        />

        <div className="w-full max-w-[440px] relative z-10">
          <div className="flex items-center gap-3.5 mb-7">
            {cfg.brand.logo?.default ? (
              <Image
                src={cfg.brand.logo.default}
                alt={brand}
                width={220}
                height={56}
                priority
                className="h-12 w-auto object-contain object-left"
              />
            ) : (
              <>
                <BlueDotsLogo size={56} />
                <div>
                  <div className="font-display font-bold text-[20px] text-ink-900 leading-none tracking-tight">
                    {brand}
                  </div>
                  <div className="text-[12.5px] text-ink-400 leading-none mt-1.5">
                    Aggregator Portal
                  </div>
                </div>
              </>
            )}
          </div>

          {error ? (
            error === 'session_expired' ? (
              <div
                role="alert"
                className="mb-5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800"
              >
                {t('session_expired')}
              </div>
            ) : error === 'org_no_portal' ? (
              <div
                role="alert"
                className="mb-5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800"
              >
                {t('org_no_portal')}
              </div>
            ) : (
              <div
                role="alert"
                className="mb-5 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700"
              >
                {t('signin_failed', { reason: humanizeError(error, t) })}
              </div>
            )
          ) : null}

          <div className="fade-up">
            <Welcome onSignIn={goSignIn} onRegister={goRegister} brand={brand} t={t} />
          </div>
        </div>
      </div>
    </div>
  );
}

type TFunction = ReturnType<typeof useTranslations<'auth'>>;

function humanizeError(code: string, t: TFunction): string {
  // Map known codes to fixed copy. Anything unrecognised becomes a generic
  // message — never reflect the raw code into the DOM, since a malicious or
  // misconfigured IdP could deliver attacker-controlled text via this query
  // param.
  const knownKeys = [
    'invalid_flow_cookie',
    'missing_code_or_state',
    'oidc_error_temporarily_unavailable',
    'oidc_error_login_required',
    'oidc_error_access_denied',
    'oidc_error_invalid_request',
    'oidc_error_server_error',
    'exchange_token_exchange_failed',
    'exchange_state_mismatch',
    'exchange_token_verify_failed',
  ] as const;

  type ErrorKey = (typeof knownKeys)[number];
  const known = new Set<string>(knownKeys);

  if (known.has(code)) {
    return t(`errors.${code as ErrorKey}`);
  }
  return t('errors.unknown');
}

interface WelcomeProps {
  onSignIn: () => void;
  onRegister: () => void;
  brand: string;
  t: TFunction;
}

/**
 * Two-card welcome surface: existing user sign-in vs new member registration.
 *
 * @param props - Callbacks for each card and translation function.
 */
function Welcome({ onSignIn, onRegister, brand, t }: WelcomeProps): JSX.Element {
  return (
    <div>
      <h2 className="font-display font-bold text-[28px] text-ink-900 tracking-tight leading-tight">
        {t('welcome_heading')}
      </h2>
      <p className="text-[14px] text-ink-500 mt-2">{t('welcome_sub')}</p>

      <div className="grid grid-cols-1 gap-2.5 mt-7">
        <button
          type="button"
          onClick={onSignIn}
          className="group w-full flex items-center justify-between gap-4 p-4 pr-5 rounded-[14px] border text-left transition-all
                     border-[var(--bd-primary)] bg-[var(--bd-primary-50)]/50 hover:bg-[var(--bd-primary-50)]"
        >
          <div className="flex items-center gap-3.5">
            <div
              className="w-9 h-9 rounded-[10px] flex items-center justify-center"
              style={{ background: 'rgba(37,99,235,0.12)' }}
            >
              <I.lock size={16} className="text-primary-700" />
            </div>
            <div>
              <div className="font-display font-bold text-[15px] text-ink-900">
                {t('existing_title')}
              </div>
              <div className="text-[12.5px] text-ink-400 mt-0.5">
                {t('existing_sub', { brand })}
              </div>
            </div>
          </div>
          <div className="w-8 h-8 rounded-full flex items-center justify-center bg-[var(--bd-primary)] text-white shrink-0">
            <I.arrowR size={14} />
          </div>
        </button>

        <button
          type="button"
          onClick={onRegister}
          className="group w-full flex items-center justify-between gap-4 p-4 pr-5 rounded-[14px] border text-left transition-all
                     border-[var(--bd-border)] hover:border-ink-300 hover:bg-ink-50/60"
        >
          <div className="flex items-center gap-3.5">
            <div className="w-9 h-9 rounded-[10px] flex items-center justify-center bg-ink-100 group-hover:bg-white transition-colors">
              <I.spark size={16} className="text-ink-600" />
            </div>
            <div>
              <div className="font-display font-bold text-[15px] text-ink-900">
                {t('register_title')}
              </div>
              <div className="text-[12.5px] text-ink-400 mt-0.5">
                {t('register_sub', { brand })}
              </div>
            </div>
          </div>
          <div className="w-8 h-8 rounded-full flex items-center justify-center bg-ink-100 text-ink-500 group-hover:bg-ink-900 group-hover:text-white transition-all shrink-0">
            <I.arrowR size={14} />
          </div>
        </button>
      </div>

      <div className="mt-5 text-[12px] text-ink-400 flex items-start gap-2">
        <span className="w-1 h-1 rounded-full bg-ink-300 mt-1.5 shrink-0" />
        {t('review_notice', { brand })}
      </div>
    </div>
  );
}
