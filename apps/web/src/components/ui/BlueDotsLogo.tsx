interface BlueDotsLogoProps {
  size?: number;
  dark?: boolean;
}

export function BlueDotsLogo({ size = 44, dark = false }: BlueDotsLogoProps) {
  const core = { x: 24, y: 24, r: 5.4 };
  const sats = [
    { x: 8, y: 12, r: 2.6 },
    { x: 40, y: 10, r: 2.0 },
    { x: 42, y: 26, r: 3.2 },
    { x: 34, y: 40, r: 2.4 },
    { x: 14, y: 38, r: 2.8 },
    { x: 6, y: 26, r: 2.0 },
  ];
  const links: [{ x: number; y: number }, { x: number; y: number }][] = [
    [core, sats[0]!],
    [core, sats[1]!],
    [core, sats[2]!],
    [core, sats[3]!],
    [core, sats[4]!],
    [core, sats[5]!],
    [sats[0]!, sats[5]!],
    [sats[2]!, sats[3]!],
    [sats[1]!, sats[2]!],
  ];

  const bg = dark ? '#0B1A3A' : '#EFF4FF';
  const ring = dark ? 'rgba(255,255,255,0.08)' : 'rgba(37,99,235,0.10)';
  const lineCol = dark ? 'rgba(147,197,253,0.55)' : 'rgba(37,99,235,0.30)';
  const dotCol = dark ? '#7DD3FC' : '#2563EB';
  const coreCol = dark ? '#FFFFFF' : '#1D4ED8';
  const glowCol = dark ? 'rgba(125,211,252,0.55)' : 'rgba(37,99,235,0.35)';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
      style={{
        display: 'block',
        borderRadius: size * 0.28,
        background: bg,
        boxShadow: dark
          ? '0 0 0 1px rgba(255,255,255,0.06), 0 18px 40px -10px rgba(37,99,235,0.55)'
          : '0 0 0 1px rgba(37,99,235,0.08), 0 8px 20px -8px rgba(37,99,235,0.25)',
      }}
    >
      <rect
        x="0.6"
        y="0.6"
        width="46.8"
        height="46.8"
        rx="13"
        fill="none"
        stroke={ring}
        strokeWidth="1"
      />
      <g stroke={lineCol} strokeWidth="0.9" strokeLinecap="round">
        {links.map(([a, b], i) => (
          <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
        ))}
      </g>
      {sats.map((s, i) => (
        <circle key={i} cx={s.x} cy={s.y} r={s.r} fill={dotCol} />
      ))}
      <circle cx={core.x} cy={core.y} r={core.r + 4} fill={glowCol} opacity="0.55" />
      <circle cx={core.x} cy={core.y} r={core.r} fill={coreCol} />
      <circle
        cx={core.x - 1.4}
        cy={core.y - 1.4}
        r="1.2"
        fill={dark ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.7)'}
      />
    </svg>
  );
}
