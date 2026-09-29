interface AvatarProps {
  initials: string;
}

const PALETTE = ['#6366F1', '#10B981', '#F59E0B', '#EC4899', '#0EA5E9', '#8B5CF6', '#14B8A6'];

export function Avatar({ initials }: AvatarProps) {
  const a = initials.codePointAt(0) ?? 0;
  const b = initials.codePointAt(1) ?? 0;
  const background = PALETTE[(a + b) % PALETTE.length] ?? '#6366F1';
  return (
    <div
      className="rounded-full flex items-center justify-center font-display font-bold text-white text-[12px] shrink-0"
      style={{
        background,
        width: '36px',
        height: '36px',
      }}
    >
      {initials}
    </div>
  );
}
