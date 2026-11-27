'use client';

import { useTranslations } from 'next-intl';
import { CreateLinkSection } from '../_components/RegistrationLinksSection';
import { OnboardingSubpage } from '../_components/OnboardingSubpage';

export default function RegistrationLinksPage() {
  const t = useTranslations('onboarding');
  return (
    <OnboardingSubpage
      title={t('links_page.title')}
      subtitle={t('links_page.subtitle')}
      backLabel={t('links_page.back')}
    >
      <CreateLinkSection />
    </OnboardingSubpage>
  );
}
