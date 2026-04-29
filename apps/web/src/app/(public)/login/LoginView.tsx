'use client';

import { useState, useRef, useEffect, type ChangeEvent, type FormEvent } from 'react';
import { BlueDotsLogo } from '../../../components/ui/BlueDotsLogo';
import { I } from '../../../icons';

interface Dot {
  ax: number;
  ay: number;
  x: number;
  y: number;
  dPhaseX: number;
  dPhaseY: number;
  dSpeedX: number;
  dSpeedY: number;
  dAmpX: number;
  dAmpY: number;
  r: number;
  pulse: number;
  hue: 'bright' | 'soft';
}

type Step = 'welcome' | 'register' | 'register-done';

export interface LoginViewProps {
  returnTo: string;
  error: string | null;
}

/**
 * Public login page.
 *
 * Three states:
 *   - welcome:        two cards — "Existing user — Sign in" and "Become a member"
 *   - register:       organisation registration form (member path)
 *   - register-done:  confirmation after submission
 *
 * The "Existing user" CTA hands off to the BFF (`/api/auth/login`), which
 * redirects to Keycloak. No credentials are collected on this page.
 */
export function LoginView({ returnTo, error }: LoginViewProps): JSX.Element {
  const [step, setStep] = useState<Step>('welcome');

  const goSignIn = (): void => {
    window.location.href = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
  };
  const goRegister = (): void => setStep('register');
  const goWelcome = (): void => setStep('welcome');
  const onRegisterSubmitted = (): void => setStep('register-done');

  return (
    <div className="min-h-screen w-full flex">
      <BrandPanel />

      <div
        className="flex-1 min-w-0 flex items-center justify-center px-6 py-8 relative overflow-hidden"
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
            <BlueDotsLogo size={56} />
            <div>
              <div className="font-display font-bold text-[20px] text-ink-900 leading-none tracking-tight">
                Blue Dots
              </div>
              <div className="text-[12.5px] text-ink-400 leading-none mt-1.5">
                Aggregator Portal
              </div>
            </div>
          </div>

          {error ? (
            <div
              role="alert"
              className="mb-5 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700"
            >
              Sign-in failed: {humanizeError(error)}. Please try again.
            </div>
          ) : null}

          <div key={step} className="fade-up">
            {step === 'welcome' && <Welcome onSignIn={goSignIn} onRegister={goRegister} />}
            {step === 'register' && (
              <RegisterForm onBack={goWelcome} onDone={onRegisterSubmitted} />
            )}
            {step === 'register-done' && <RegisterDone onBack={goWelcome} />}
          </div>

          <div className="mt-8 text-[12px] text-ink-400">
            By continuing you agree to the{' '}
            <button type="button" className="text-primary-600 hover:underline">
              Privacy Policy
            </button>{' '}
            and{' '}
            <button type="button" className="text-primary-600 hover:underline">
              Terms
            </button>
            .
          </div>

          <div className="mt-6 pt-5 border-t border-ink-100 flex items-center justify-between text-[12px]">
            <div className="flex items-center gap-2 text-ink-500">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
              Invite-only · Blue Dots SSO
            </div>
            <button type="button" className="text-primary-600 font-semibold hover:underline">
              Need help?
            </button>
          </div>
        </div>

        <div className="absolute bottom-5 right-6 text-[11px] text-ink-300 font-mono z-10">
          v2.4.0 · build 7281
        </div>
      </div>
    </div>
  );
}

function humanizeError(code: string): string {
  // Map known codes to fixed copy. Anything unrecognised becomes a generic
  // message — never reflect the raw code into the DOM, since a malicious or
  // misconfigured IdP could deliver attacker-controlled text via this query
  // param.
  const known: Record<string, string> = {
    invalid_flow_cookie: 'session handshake expired',
    missing_code_or_state: 'incomplete callback',
    oidc_error_temporarily_unavailable: 'sign-in session expired before completing',
    oidc_error_login_required: 'sign-in is required to continue',
    oidc_error_access_denied: 'sign-in was cancelled',
    oidc_error_invalid_request: 'sign-in request was invalid',
    oidc_error_server_error: 'identity provider is temporarily unavailable',
    exchange_token_exchange_failed: 'token exchange failed',
    exchange_state_mismatch: 'security check failed (state mismatch)',
    exchange_token_verify_failed: 'security check failed (token verification)',
  };
  return known[code] ?? 'unexpected sign-in error';
}

interface WelcomeProps {
  onSignIn: () => void;
  onRegister: () => void;
}

/**
 * Two-card welcome surface: existing user sign-in vs new member registration.
 *
 * @param props - Callbacks for each card.
 */
function Welcome({ onSignIn, onRegister }: WelcomeProps): JSX.Element {
  return (
    <div>
      <h2 className="font-display font-bold text-[28px] text-ink-900 tracking-tight leading-tight">
        Welcome back.
      </h2>
      <p className="text-[14px] text-ink-500 mt-2">
        Sign in or register your organisation to get started.
      </p>

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
                Existing user — Sign in
              </div>
              <div className="text-[12.5px] text-ink-400 mt-0.5">
                Continue with email or mobile via Blue Dots SSO
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
              <div className="font-display font-bold text-[15px] text-ink-900">Become a member</div>
              <div className="text-[12.5px] text-ink-400 mt-0.5">
                Register your organisation with Blue Dots
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
        New registrations are reviewed by the Blue Dots team within 1–2 business days.
      </div>
    </div>
  );
}

interface RegisterFormProps {
  onBack: () => void;
  onDone: () => void;
}

interface RegState {
  assoc: string;
  sub: string;
  name: string;
  email: string;
  phone: string;
}

/**
 * Aggregator organisation registration form. Submits to the registration
 * endpoint (currently a stub) and transitions to the confirmation step.
 *
 * @param props - Callbacks for back navigation and post-submit transition.
 */
function RegisterForm({ onBack, onDone }: RegisterFormProps): JSX.Element {
  const [f, setF] = useState<RegState>({
    assoc: '',
    sub: '',
    name: '',
    email: '',
    phone: '',
  });
  const [submitting, setSubmitting] = useState(false);

  const set =
    (k: keyof RegState) =>
    (e: ChangeEvent<HTMLInputElement>): void =>
      setF((prev) => ({ ...prev, [k]: e.target.value }));

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email);
  const phoneOk = f.phone.replace(/\D/g, '').length >= 10;
  const canSubmit = Boolean(f.assoc && f.name && emailOk && phoneOk) && !submitting;

  const handleSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      // Registration endpoint stub. When apps/api ships a real handler, swap
      // this URL — payload shape is intended to match.
      await fetch('/api/aggregator/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(f),
      }).catch(() => undefined);
      onDone();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-2 text-[13.5px] text-ink-500 hover:text-ink-900 transition-colors"
      >
        <I.arrowL size={15} /> Back
      </button>

      <h2 className="font-display font-bold text-[28px] text-ink-900 tracking-tight leading-tight mt-3">
        Register as Aggregator
      </h2>
      <p className="text-[14px] text-ink-500 mt-2">
        Tell us about your organisation. Reviewed within 1–2 business days.
      </p>

      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
        <RegField
          label="Association"
          placeholder="e.g. TRRAIN, Pankh Foundation"
          value={f.assoc}
          onChange={set('assoc')}
          colSpan={2}
        />
        <RegField
          label="Sub Association"
          placeholder="Chapter / Region (optional)"
          value={f.sub}
          onChange={set('sub')}
          colSpan={2}
        />
        <RegField
          label="Contact Name"
          placeholder="Full name"
          value={f.name}
          onChange={set('name')}
        />
        <RegField
          label="Email"
          type="email"
          placeholder="name@org.in"
          value={f.email}
          onChange={set('email')}
          invalid={Boolean(f.email) && !emailOk}
        />
        <RegField
          label="Phone"
          type="tel"
          placeholder="+91 ..."
          value={f.phone}
          onChange={set('phone')}
          invalid={Boolean(f.phone) && !phoneOk}
          colSpan={2}
        />
      </div>

      <button
        type="submit"
        disabled={!canSubmit}
        className={`mt-6 w-full py-3 rounded-[12px] font-display font-bold text-[15px] text-white transition-all
          ${
            canSubmit
              ? 'bg-[var(--bd-primary)] hover:bg-[var(--bd-primary-600)] bd-shadow-lg'
              : 'bg-[var(--bd-primary-100)] text-[var(--bd-primary-600)] cursor-not-allowed'
          }`}
      >
        {submitting ? 'Submitting…' : 'Submit application'}
      </button>

      <div className="mt-4 text-[12px] text-ink-400 flex items-start gap-2">
        <span className="w-1 h-1 rounded-full bg-ink-300 mt-1.5 shrink-0" />
        Your application will be reviewed by the Blue Dots team. You{'’'}ll receive an email once
        approved, then sign in via Blue Dots SSO.
      </div>
    </form>
  );
}

function RegisterDone({ onBack }: { onBack: () => void }): JSX.Element {
  return (
    <div>
      <h2 className="font-display font-bold text-[28px] text-ink-900 tracking-tight leading-tight">
        Application received
      </h2>
      <p className="text-[14px] text-ink-500 mt-2">
        Thanks — the Blue Dots team will get back to you within 1–2 business days. Once approved,
        sign in via Blue Dots SSO using the email or mobile you registered.
      </p>
      <button
        type="button"
        onClick={onBack}
        className="mt-6 inline-flex items-center gap-2 text-[13.5px] text-primary-600 font-semibold hover:underline"
      >
        <I.arrowL size={15} /> Back to sign-in
      </button>
    </div>
  );
}

interface RegFieldProps {
  label: string;
  type?: string;
  placeholder?: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  invalid?: boolean;
  hint?: string;
  colSpan?: 1 | 2;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function RegField({
  label,
  type = 'text',
  placeholder,
  value,
  onChange,
  invalid,
  hint,
  colSpan = 1,
}: RegFieldProps): JSX.Element {
  const id = `reg-${slug(label)}`;
  return (
    <div className={colSpan === 2 ? 'sm:col-span-2' : ''}>
      <label className="bd-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type={type}
        {...(placeholder !== undefined ? { placeholder } : {})}
        value={value}
        onChange={onChange}
        className="bd-input"
        {...(invalid ? { style: { borderColor: '#EF4444' } } : {})}
      />
      {hint ? <div className="text-[11.5px] text-[#EF4444] mt-1">{hint}</div> : null}
    </div>
  );
}

function BrandPanel(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx: CanvasRenderingContext2D | null = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = (): void => {
      const r = canvas.getBoundingClientRect();
      canvas.width = r.width * dpr;
      canvas.height = r.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    let dots: Dot[] = [];

    const buildDots = (): void => {
      const W = canvas.getBoundingClientRect().width;
      const H = canvas.getBoundingClientRect().height;
      if (W < 10 || H < 10) return;
      const COUNT = Math.max(55, Math.min(85, Math.round((W * H) / 18000)));
      const aspect = W / H;
      const COLS = Math.max(6, Math.round(Math.sqrt(COUNT * aspect)));
      const ROWS = Math.ceil(COUNT / COLS);
      const cellW = W / COLS;
      const cellH = H / ROWS;
      const next: Dot[] = [];
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          if (next.length >= COUNT) break;
          const cx = cellW * (c + 0.2 + Math.random() * 0.6);
          const cy = cellH * (r + 0.2 + Math.random() * 0.6);
          next.push({
            ax: cx,
            ay: cy,
            x: cx,
            y: cy,
            dPhaseX: Math.random() * Math.PI * 2,
            dPhaseY: Math.random() * Math.PI * 2,
            dSpeedX: 0.003 + Math.random() * 0.004,
            dSpeedY: 0.003 + Math.random() * 0.004,
            dAmpX: 6 + Math.random() * 10,
            dAmpY: 6 + Math.random() * 10,
            r: Math.random() * 1.6 + 1.6,
            pulse: Math.random() * Math.PI * 2,
            hue: Math.random() < 0.22 ? 'bright' : 'soft',
          });
        }
      }
      dots = next;
    };

    const onResize = (): void => {
      resize();
      buildDots();
    };
    onResize();
    const ro = new ResizeObserver(onResize);
    ro.observe(canvas);

    const W = (): number => canvas.getBoundingClientRect().width;
    const H = (): number => canvas.getBoundingClientRect().height;

    const draw = (): void => {
      const w = W();
      const h = H();
      ctx.clearRect(0, 0, w, h);

      const LINK = 200;
      for (let i = 0; i < dots.length; i++) {
        for (let j = i + 1; j < dots.length; j++) {
          const a = dots[i];
          const b = dots[j];
          if (!a || !b) continue;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < LINK) {
            const o = 1 - d / LINK;
            ctx.strokeStyle = `rgba(165,200,255,${o * 0.55})`;
            ctx.lineWidth = 0.9;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      dots.forEach((d) => {
        d.dPhaseX += d.dSpeedX;
        d.dPhaseY += d.dSpeedY;
        d.x = d.ax + Math.sin(d.dPhaseX) * d.dAmpX;
        d.y = d.ay + Math.cos(d.dPhaseY) * d.dAmpY;

        d.pulse += 0.02;
        const pulse = (Math.sin(d.pulse) + 1) / 2;
        const r = d.r + pulse * 0.6;

        const isBright = d.hue === 'bright';
        const core = isBright ? '#7DD3FC' : '#93C5FD';
        const glow = isBright ? 'rgba(125,211,252,' : 'rgba(147,197,253,';

        const grad = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, r * 6);
        grad.addColorStop(0, glow + (0.5 + pulse * 0.3) + ')');
        grad.addColorStop(1, glow + '0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(d.x, d.y, r * 6, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = core;
        ctx.beginPath();
        ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
        ctx.fill();
      });

      raf = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <div
      className="hidden lg:flex relative w-[58%] flex-col justify-between p-12 overflow-hidden text-white"
      style={{ background: 'linear-gradient(135deg, #0F172A 0%, #172554 45%, #1E3A5F 100%)' }}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0"
        style={{ display: 'block', width: '100%', height: '100%' }}
      />

      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(700px 500px at 75% 25%, rgba(56,189,248,0.18) 0%, rgba(56,189,248,0) 60%),' +
            'radial-gradient(600px 480px at 15% 85%, rgba(99,102,241,0.20) 0%, rgba(99,102,241,0) 60%)',
        }}
      />

      <div className="relative z-10 max-w-[520px]">
        <h1 className="font-display font-bold tracking-tight leading-[1.05] text-[56px] text-white">
          Connecting{' '}
          <span
            style={{
              background: 'linear-gradient(120deg,#A5F3FC 0%,#93C5FD 50%,#C7D2FE 100%)',
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              color: 'transparent',
            }}
          >
            opportunity
          </span>
          <br />
          seekers with the
          <br />
          right doors.
        </h1>

        <p className="text-[15px] text-white/70 leading-relaxed mt-5 max-w-[460px]">
          A unified network where aggregators, providers, and seekers move together — every blue dot
          is a person, an opportunity, a path forward.
        </p>

        <div className="flex items-center gap-7 mt-8 pt-6 border-t border-white/10">
          <BrandStat n="2.4M+" label="Seekers" />
          <BrandStat n="18K" label="Providers" />
          <BrandStat n="142" label="Aggregators" />
          <BrandStat n="34%" label="Match rate" />
        </div>
      </div>

      <div className="relative z-10" />
    </div>
  );
}

function BrandStat({ n, label }: { n: string; label: string }): JSX.Element {
  return (
    <div>
      <div className="font-display font-bold text-[22px] text-white leading-none tracking-tight">
        {n}
      </div>
      <div className="text-[11.5px] text-white/55 mt-1.5">{label}</div>
    </div>
  );
}
