import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { refresh, setLocale } = vi.hoisted(() => ({
  refresh: vi.fn(),
  setLocale: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string) => (key === 'label' ? 'Language' : key),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/i18n/locale-cookie', () => ({ setLocale }));

import { LanguageSwitcher } from '@/components/shell/LanguageSwitcher';

// jsdom does not implement scrollIntoView; Radix Select's open-item-scroll
// logic calls it unconditionally when the content mounts. Stub it locally
// (rather than in the shared test setup) since only Select-opening tests
// need it.
beforeEach(() => {
  refresh.mockClear();
  setLocale.mockClear();
  delete process.env.NEXT_PUBLIC_ENABLED_LANGUAGES;
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
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

  it('persists the new locale and refreshes the route on selection', async () => {
    render(<LanguageSwitcher />);
    // Radix Select's trigger is a native <button role="combobox">; open it and
    // pick the "kn" item via its accessible role rather than simulating a
    // native <select> change event (Select is not a native element here).
    fireEvent.click(screen.getByRole('combobox'));
    const option = await screen.findByText('ಕನ್ನಡ');
    fireEvent.click(option);
    await vi.waitFor(() => expect(setLocale).toHaveBeenCalledWith('kn'));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
