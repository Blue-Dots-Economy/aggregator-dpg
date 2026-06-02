import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { refresh, setLocale } = vi.hoisted(() => ({
  refresh: vi.fn(),
  setLocale: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/i18n/locale-cookie', () => ({ setLocale }));

import { LanguageSwitcher } from '@/components/shell/LanguageSwitcher';

beforeEach(() => {
  refresh.mockClear();
  setLocale.mockClear();
  delete process.env.NEXT_PUBLIC_ENABLED_LANGUAGES;
});

describe('<LanguageSwitcher />', () => {
  it('renders a trigger labelled with the language label when >1 locale enabled', () => {
    render(<LanguageSwitcher />);
    expect(screen.getByLabelText('Language')).toBeInTheDocument();
  });

  it('renders nothing when fewer than two locales are enabled', () => {
    process.env.NEXT_PUBLIC_ENABLED_LANGUAGES = 'en';
    const { container } = render(<LanguageSwitcher />);
    expect(container).toBeEmptyDOMElement();
  });
});
