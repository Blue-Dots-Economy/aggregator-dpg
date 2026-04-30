'use client';

import { useRef, useEffect } from 'react';

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

/**
 * Animated brand panel rendering the Blue Dots particle network on a canvas.
 * Shared by the public login and register pages so both have an identical
 * left-side hero.
 *
 * @returns Brand panel React element with hero copy and stats.
 */
export function BrandPanel(): JSX.Element {
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
      className="hidden lg:flex relative w-[52%] flex-col justify-between p-12 overflow-hidden text-white"
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
        <h1 className="font-display font-bold tracking-tight leading-[1.05] text-[48px] xl:text-[56px] text-white">
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
