import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { BlueDotsLogo } from '../components/ui/BlueDotsLogo';
import { I } from '../icons';
import { ORGS } from '../data/mock';
import { useAuth } from '../lib/auth-context';

type Step = 'welcome' | 'login' | 'register';
type Path = 'existing' | 'member' | null;

interface SubmitPayload {
  org: string;
  password: string;
}

/**
 * Login route — split-screen brand panel + Welcome → Log in / Register flow.
 *
 * Renders the unauthenticated entry point of the portal. Drives the auth
 * context's signIn and navigates to the post-login landing page on success.
 */
export function LoginRoute() {
  const navigate = useNavigate();
  const { signIn } = useAuth();

  const [step, setStep] = useState<Step>('welcome');
  const [_path, setPath] = useState<Path>(null);
  const [org, setOrg] = useState<string>('');
  const [pw, setPw] = useState<string>('');

  const goWelcome = () => {
    setStep('welcome');
  };

  const goLogin = (p: Exclude<Path, null>) => {
    setPath(p);
    setStep(p === 'member' ? 'register' : 'login');
  };

  const handleSubmit = async ({ org: o, password }: SubmitPayload) => {
    await signIn({ org: o, password });
    navigate('/blue-dots');
  };

  return (
    <div className="min-h-screen w-full flex">
      {/* Left brand panel */}
      <BrandPanel />

      {/* Right form panel */}
      <div
        className="flex-1 min-w-0 flex items-center justify-center px-6 py-8 relative overflow-hidden"
        style={{ background: '#FBFCFE' }}
      >
        {/* subtle texture: dot-grid + soft tint blobs */}
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
        <div
          aria-hidden
          className="absolute -top-32 -right-32 w-[480px] h-[480px] rounded-full pointer-events-none"
          style={{
            background: 'radial-gradient(circle, rgba(99,102,241,0.10) 0%, rgba(99,102,241,0) 65%)',
          }}
        />
        <div
          aria-hidden
          className="absolute -bottom-40 -left-24 w-[420px] h-[420px] rounded-full pointer-events-none"
          style={{
            background: 'radial-gradient(circle, rgba(56,189,248,0.10) 0%, rgba(56,189,248,0) 65%)',
          }}
        />

        <div className="w-full max-w-[440px] relative z-10">
          {/* brand mark above form */}
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

          <div key={step} className="fade-up">
            {step === 'welcome' && <Welcome onPath={goLogin} />}
            {step === 'login' && (
              <LoginForm
                org={org}
                setOrg={setOrg}
                pw={pw}
                setPw={setPw}
                onBack={goWelcome}
                onSubmit={handleSubmit}
              />
            )}
            {step === 'register' && <RegisterForm onBack={goWelcome} onSubmit={handleSubmit} />}
          </div>

          <div className="mt-8 text-[12px] text-ink-400">
            By continuing you agree to the{' '}
            <a className="text-primary-600 hover:underline">Privacy Policy</a> and{' '}
            <a className="text-primary-600 hover:underline">Terms</a>.
          </div>

          {/* support row — fills lower whitespace, signals invite-only nature */}
          <div className="mt-6 pt-5 border-t border-ink-100 flex items-center justify-between text-[12px]">
            <div className="flex items-center gap-2 text-ink-500">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
              Invite-only · Blue Dots SSO
            </div>
            <a className="text-primary-600 font-semibold hover:underline">Need help?</a>
          </div>
        </div>

        {/* version chip */}
        <div className="absolute bottom-5 right-6 text-[11px] text-ink-300 font-mono z-10">
          v2.4.0 · build 7281
        </div>
      </div>
    </div>
  );
}

/* ───────────── Brand panel with particle network ───────────── */

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

function BrandPanel() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx: CanvasRenderingContext2D | null = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = r.width * dpr;
      canvas.height = r.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    let dots: Dot[] = [];

    const buildDots = () => {
      const W = canvas.getBoundingClientRect().width;
      const H = canvas.getBoundingClientRect().height;
      if (W < 10 || H < 10) return;
      // Sparse density — fewer dots, evenly scattered across the whole panel
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

    const onResize = () => {
      resize();
      buildDots();
    };
    onResize();
    const ro = new ResizeObserver(onResize);
    ro.observe(canvas);

    const W = () => canvas.getBoundingClientRect().width;
    const H = () => canvas.getBoundingClientRect().height;

    const draw = () => {
      const w = W();
      const h = H();
      ctx.clearRect(0, 0, w, h);

      // lines
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

      // dots
      dots.forEach((d) => {
        // gentle drift around anchor — dots stay in their region
        d.dPhaseX += d.dSpeedX;
        d.dPhaseY += d.dSpeedY;
        d.x = d.ax + Math.sin(d.dPhaseX) * d.dAmpX;
        d.y = d.ay + Math.cos(d.dPhaseY) * d.dAmpY;

        d.pulse += 0.02;
        const pulse = (Math.sin(d.pulse) + 1) / 2; // 0..1
        const r = d.r + pulse * 0.6;

        const isBright = d.hue === 'bright';
        const core = isBright ? '#7DD3FC' : '#93C5FD';
        const glow = isBright ? 'rgba(125,211,252,' : 'rgba(147,197,253,';

        // glow halo
        const grad = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, r * 6);
        grad.addColorStop(0, glow + (0.5 + pulse * 0.3) + ')');
        grad.addColorStop(1, glow + '0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(d.x, d.y, r * 6, 0, Math.PI * 2);
        ctx.fill();

        // core dot
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
      style={{
        background: 'linear-gradient(135deg, #0F172A 0%, #172554 45%, #1E3A5F 100%)',
      }}
    >
      {/* canvas network */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0"
        style={{ display: 'block', width: '100%', height: '100%' }}
      />

      {/* radial highlights */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(700px 500px at 75% 25%, rgba(56,189,248,0.18) 0%, rgba(56,189,248,0) 60%),' +
            'radial-gradient(600px 480px at 15% 85%, rgba(99,102,241,0.20) 0%, rgba(99,102,241,0) 60%)',
        }}
      />

      {/* grid texture */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.06] pointer-events-none"
        style={{
          backgroundImage:
            'linear-gradient(to right, #fff 1px, transparent 1px), linear-gradient(to bottom, #fff 1px, transparent 1px)',
          backgroundSize: '60px 60px',
          maskImage: 'radial-gradient(ellipse at center, #000 30%, transparent 75%)',
          WebkitMaskImage: 'radial-gradient(ellipse at center, #000 30%, transparent 75%)',
        }}
      />

      {/* hero copy */}
      <div className="relative z-10 max-w-[520px]">
        <h1 className="font-display font-bold tracking-tight leading-[1.05] text-[56px] text-white">
          Connecting{' '}
          <span className="relative">
            <span
              className="relative z-10"
              style={{
                background: 'linear-gradient(120deg,#A5F3FC 0%,#93C5FD 50%,#C7D2FE 100%)',
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                color: 'transparent',
              }}
            >
              opportunity
            </span>
          </span>
          <br />
          seekers with the
          <br />
          right doors.
        </h1>

        <p className="text-[15px] text-white/70 leading-relaxed mt-5 max-w-[460px]">
          A unified network where providers, and seekers move together — every blue dot is a person,
          an opportunity, a path forward.
        </p>

        <div className="flex items-center gap-7 mt-8 pt-6 border-t border-white/10">
          <BrandStat n="2.4M+" label="Seekers" />
          <BrandStat n="18K" label="Providers" />
          <BrandStat n="142" label="Aggregators" />
          <BrandStat n="34%" label="Match rate" />
        </div>
      </div>

      {/* footer attribution */}
      <div className="relative z-10"></div>
    </div>
  );
}

interface BrandStatProps {
  n: string;
  label: string;
}

function BrandStat({ n, label }: BrandStatProps) {
  return (
    <div>
      <div className="font-display font-bold text-[22px] text-white leading-none tracking-tight">
        {n}
      </div>
      <div className="text-[11.5px] text-white/55 mt-1.5">{label}</div>
    </div>
  );
}

interface WelcomeProps {
  onPath: (p: Exclude<Path, null>) => void;
}

function Welcome({ onPath }: WelcomeProps) {
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
          onClick={() => onPath('existing')}
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
                Use your aggregator credentials
              </div>
            </div>
          </div>
          <div className="w-8 h-8 rounded-full flex items-center justify-center bg-[var(--bd-primary)] text-white shrink-0">
            <I.arrowR size={14} />
          </div>
        </button>

        <button
          onClick={() => onPath('member')}
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

interface LoginFormProps {
  org: string;
  setOrg: (v: string) => void;
  pw: string;
  setPw: (v: string) => void;
  onBack: () => void;
  onSubmit: (payload: SubmitPayload) => void | Promise<void>;
}

function LoginForm({ org, setOrg, pw, setPw, onBack, onSubmit }: LoginFormProps) {
  const canSubmit = org.length > 0 && pw.length >= 4;

  return (
    <form
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (canSubmit) void onSubmit({ org, password: pw });
      }}
    >
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-2 text-[13.5px] text-ink-500 hover:text-ink-900 transition-colors"
      >
        <I.arrowL size={15} /> Back
      </button>

      <h2 className="font-display font-bold text-[28px] text-ink-900 tracking-tight leading-tight mt-3">
        Log in
      </h2>
      <p className="text-[14px] text-ink-500 mt-2">Aggregator account</p>

      <div className="mt-6 flex flex-col gap-4">
        <div>
          <label className="bd-label">Organisation</label>
          <div className="relative">
            <select
              className="bd-input appearance-none pr-10"
              value={org}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => setOrg(e.target.value)}
              style={{ color: org ? '#0B1020' : '#9098B5' }}
            >
              <option value="">— Organisation —</option>
              {ORGS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <I.chevD
              size={14}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none"
            />
          </div>
        </div>

        <div>
          <label className="bd-label">Password</label>
          <input
            type="password"
            className="bd-input"
            value={pw}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setPw(e.target.value)}
            placeholder="••••••••"
          />
        </div>

        <button
          type="submit"
          disabled={!canSubmit}
          className={`mt-2 w-full py-3 rounded-[12px] font-display font-bold text-[15px] text-white transition-all
            ${
              canSubmit
                ? 'bg-[var(--bd-primary)] hover:bg-[var(--bd-primary-600)] bd-shadow-lg'
                : 'bg-[var(--bd-primary-100)] text-[var(--bd-primary-600)] cursor-not-allowed'
            }`}
        >
          Log in
        </button>

        <div className="flex items-center justify-between text-[12.5px]">
          <button type="button" className="text-ink-500 hover:text-ink-900">
            Forgot password?
          </button>
          <button type="button" className="text-primary-600 font-semibold hover:underline">
            Get help
          </button>
        </div>
      </div>
    </form>
  );
}

interface RegisterFormProps {
  onBack: () => void;
  onSubmit: (payload: SubmitPayload) => void | Promise<void>;
}

interface RegisterState {
  assoc: string;
  sub: string;
  name: string;
  email: string;
  phone: string;
  pw: string;
  cpw: string;
}

function RegisterForm({ onBack, onSubmit }: RegisterFormProps) {
  const [f, setF] = useState<RegisterState>({
    assoc: '',
    sub: '',
    name: '',
    email: '',
    phone: '',
    pw: '',
    cpw: '',
  });
  const set = (k: keyof RegisterState) => (e: ChangeEvent<HTMLInputElement>) =>
    setF((prev) => ({ ...prev, [k]: e.target.value }));

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email);
  const phoneOk = f.phone.replace(/\D/g, '').length >= 10;
  const pwOk = f.pw.length >= 6;
  const matchOk = f.pw === f.cpw && f.cpw.length > 0;
  const canSubmit =
    f.assoc.length > 0 &&
    f.sub.length > 0 &&
    f.name.length > 0 &&
    emailOk &&
    phoneOk &&
    pwOk &&
    matchOk;

  return (
    <form
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (canSubmit) void onSubmit({ org: f.assoc, password: f.pw });
      }}
    >
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
          invalid={f.email.length > 0 && !emailOk}
        />
        <RegField
          label="Phone"
          type="tel"
          placeholder="+91 ..."
          value={f.phone}
          onChange={set('phone')}
          invalid={f.phone.length > 0 && !phoneOk}
        />
        <RegField
          label="Password"
          type="password"
          placeholder="At least 6 characters"
          value={f.pw}
          onChange={set('pw')}
          {...(f.pw.length > 0 && !pwOk ? { hint: 'Use at least 6 characters' } : {})}
        />
        <RegField
          label="Confirm Password"
          type="password"
          placeholder="Repeat password"
          value={f.cpw}
          onChange={set('cpw')}
          invalid={f.cpw.length > 0 && !matchOk}
          {...(f.cpw.length > 0 && !matchOk ? { hint: 'Passwords don’t match' } : {})}
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
        Register as Aggregator
      </button>

      <div className="mt-4 text-[12px] text-ink-400 flex items-start gap-2">
        <span className="w-1 h-1 rounded-full bg-ink-300 mt-1.5 shrink-0" />
        Your registration will be reviewed by the Blue Dots team. You’ll receive an email once
        approved.
      </div>
    </form>
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
  colSpan?: number;
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
}: RegFieldProps) {
  return (
    <div className={colSpan === 2 ? 'sm:col-span-2' : ''}>
      <label className="bd-label">{label}</label>
      <input
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        className="bd-input"
        style={invalid ? { borderColor: '#EF4444' } : undefined}
      />
      {hint && <div className="text-[11.5px] text-[#EF4444] mt-1">{hint}</div>}
    </div>
  );
}
