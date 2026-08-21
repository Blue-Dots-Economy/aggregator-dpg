import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '@/i18n/messages/en.json';
import { ConsentGate } from '@/components/consent/ConsentGate';
import type { ConsentDoc } from '@/components/consent/consent-docs';

const docs: ConsentDoc[] = [
  { id: 'privacy', cap: 'Privacy', title: 'Privacy Policy', body: 'Privacy body' },
  { id: 'terms', cap: 'Terms', title: 'Terms of Service', body: 'Terms body' },
];

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}

/**
 * jsdom lays nothing out, so the gate would see a 0x0 scroller and treat it as
 * unscrollable (correctly — an unmeasurable box cannot be scrolled). To drive
 * the locked path we stub a taller-than-viewport scroller.
 */
function stubScroller(scrollHeight: number, clientHeight: number, scrollTop = 0) {
  const el = screen.getByTestId('consent-reader');
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  Object.defineProperty(el, 'scrollTop', { value: scrollTop, writable: true, configurable: true });
  for (const doc of docs) {
    const section = el.querySelector<HTMLElement>(`[data-consent-section="${doc.id}"]`)!;
    const top = doc.id === 'privacy' ? 0 : 300;
    Object.defineProperty(section, 'offsetTop', { value: top, configurable: true });
    Object.defineProperty(section, 'offsetHeight', { value: 300, configurable: true });
  }
  return el;
}

// ResizeObserver is stubbed globally in src/__tests__/setup.ts.

describe('<ConsentGate />', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <Wrapper>
        <ConsentGate open={false} docs={docs} agreeLabel="I agree" onAccept={vi.fn()} />
      </Wrapper>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when there are no documents to show', () => {
    const { container } = render(
      <Wrapper>
        <ConsentGate open docs={[]} agreeLabel="I agree" onAccept={vi.fn()} />
      </Wrapper>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps the checkbox and CTA locked until every document has been read', () => {
    render(
      <Wrapper>
        <ConsentGate open docs={docs} agreeLabel="I agree" onAccept={vi.fn()} />
      </Wrapper>,
    );
    const el = stubScroller(600, 200, 0);
    fireEvent.scroll(el);
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Accept & continue' })).toBeDisabled();
    expect(screen.getByText('Scroll to the end to unlock the checkbox.')).toBeInTheDocument();
  });

  it('unlocks the checkbox at the end, then the CTA once ticked', () => {
    const onAccept = vi.fn();
    render(
      <Wrapper>
        <ConsentGate open docs={docs} agreeLabel="I agree" onAccept={onAccept} />
      </Wrapper>,
    );
    const el = stubScroller(600, 200, 400);
    fireEvent.scroll(el);

    const box = screen.getByRole('checkbox');
    expect(box).toBeEnabled();
    expect(screen.getByText('You have reached the end — you can agree now.')).toBeInTheDocument();

    const cta = screen.getByRole('button', { name: 'Accept & continue' });
    expect(cta).toBeDisabled();
    fireEvent.click(box);
    expect(cta).toBeEnabled();
    fireEvent.click(cta);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('treats content shorter than the viewport as read — the 111-character case', () => {
    render(
      <Wrapper>
        <ConsentGate
          open
          docs={[{ id: 'profile', cap: 'Profile', title: 'Profile creation', body: 'Short.' }]}
          agreeLabel="I agree"
          onAccept={vi.fn()}
        />
      </Wrapper>,
    );
    // jsdom performs no layout, so an un-stubbed reader reports 0x0 — which
    // computeReadProgress correctly treats as "not yet measured", not as
    // "shorter than the viewport" (see its own dedicated guard against that
    // ambiguity). To exercise the real-world case — a document that fits
    // without scrolling — we stub the one section as unscrollable, the same
    // way `stubScroller` does above.
    const el = screen.getByTestId('consent-reader');
    Object.defineProperty(el, 'scrollHeight', { value: 100, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
    const section = el.querySelector<HTMLElement>('[data-consent-section="profile"]')!;
    Object.defineProperty(section, 'offsetTop', { value: 0, configurable: true });
    Object.defineProperty(section, 'offsetHeight', { value: 100, configurable: true });
    fireEvent.scroll(el);

    expect(screen.getByRole('checkbox')).toBeEnabled();
  });

  it('does not dismiss on Escape or backdrop click', () => {
    const onCancel = vi.fn();
    render(
      <Wrapper>
        <ConsentGate open docs={docs} agreeLabel="I agree" onAccept={vi.fn()} onCancel={onCancel} />
      </Wrapper>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('consent-gate-backdrop'));
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('calls onCancel from the explicit close button only', () => {
    const onCancel = vi.fn();
    render(
      <Wrapper>
        <ConsentGate open docs={docs} agreeLabel="I agree" onAccept={vi.fn()} onCancel={onCancel} />
      </Wrapper>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
