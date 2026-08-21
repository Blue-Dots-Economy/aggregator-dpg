import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '@/i18n/messages/en.json';
import { ConsentProgressTracker } from '@/components/consent/ConsentProgressTracker';
import type { ConsentDoc } from '@/components/consent/consent-docs';

const docs: ConsentDoc[] = [
  { id: 'privacy', cap: 'Privacy', title: 'Privacy Policy', body: 'p' },
  { id: 'terms', cap: 'Terms', title: 'Terms of Service', body: 't' },
];

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}

describe('<ConsentProgressTracker />', () => {
  it('marks the first document current and the rest todo at the start', () => {
    render(
      <Wrapper>
        <ConsentProgressTracker
          docs={docs}
          progress={{ readIds: [], currentId: 'privacy', fillPercent: 0, allRead: false }}
        />
      </Wrapper>,
    );
    expect(screen.getByTestId('consent-node-privacy')).toHaveAttribute('data-state', 'current');
    expect(screen.getByTestId('consent-node-terms')).toHaveAttribute('data-state', 'todo');
  });

  it('marks read documents read and reflects fill on the connecting line', () => {
    render(
      <Wrapper>
        <ConsentProgressTracker
          docs={docs}
          progress={{ readIds: ['privacy'], currentId: 'terms', fillPercent: 50, allRead: false }}
        />
      </Wrapper>,
    );
    expect(screen.getByTestId('consent-node-privacy')).toHaveAttribute('data-state', 'read');
    expect(screen.getByTestId('consent-node-terms')).toHaveAttribute('data-state', 'current');
    expect(screen.getByTestId('consent-progress-fill')).toHaveStyle({ width: '50%' });
  });

  it('renders nothing for a single document — a tracker of one conveys nothing', () => {
    const { container } = render(
      <Wrapper>
        <ConsentProgressTracker
          docs={[docs[0]!]}
          progress={{ readIds: [], currentId: 'privacy', fillPercent: 0, allRead: false }}
        />
      </Wrapper>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('prefers the consent_gate.cap_* translation over the doc.cap fallback', () => {
    // doc.cap is deliberately not the real label, so the assertion only
    // passes if the rendered text came from the translation key.
    const staleCap: ConsentDoc[] = [
      { id: 'privacy', cap: 'stale-fallback-label', title: 'Privacy Policy', body: 'p' },
      { id: 'terms', cap: 'Terms', title: 'Terms of Service', body: 't' },
    ];
    render(
      <Wrapper>
        <ConsentProgressTracker
          docs={staleCap}
          progress={{ readIds: [], currentId: 'privacy', fillPercent: 0, allRead: false }}
        />
      </Wrapper>,
    );
    expect(screen.getByTestId('consent-node-privacy')).toHaveTextContent(
      messages.consent_gate.cap_privacy,
    );
    expect(screen.queryByText('stale-fallback-label')).not.toBeInTheDocument();
  });
});
