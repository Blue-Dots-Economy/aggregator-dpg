'use client';

import { useRouter } from 'next/navigation';
import { Topbar } from '../../../../components/shell/Topbar';
import { I } from '../../../../icons';
import { CreateLinkSection, YourLinks } from '../_components/RegistrationLinksSection';

export default function RegistrationLinksPage() {
  const router = useRouter();
  return (
    <div className="fade-up flex flex-col gap-5">
      <Topbar
        title="Registration Links"
        subtitle="Generate, share, and manage public registration links."
        right={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => router.push('/onboarding')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border border-[var(--bd-border)] bg-white text-[12.5px] font-semibold text-ink-700 hover:text-primary-600 hover:bg-[var(--bd-primary-50)] transition-colors"
            >
              <I.chevL size={14} />
              Back to Onboarding
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              title="Refresh page"
              aria-label="Refresh page"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border border-[var(--bd-border)] bg-white text-[12.5px] font-semibold text-ink-700 hover:text-primary-600 hover:bg-[var(--bd-primary-50)] transition-colors"
            >
              <I.refresh size={14} />
              Refresh
            </button>
          </div>
        }
      />
      <CreateLinkSection />
      <YourLinks />
    </div>
  );
}
