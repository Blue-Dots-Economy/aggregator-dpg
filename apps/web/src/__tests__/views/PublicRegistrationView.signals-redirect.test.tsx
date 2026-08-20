/**
 * View test: the post-submit hand-off to the Signals UI (#635).
 *
 * Covers the countdown that runs on the success panel, the immediate
 * `Continue to Signals` button, the `Register another` cancel (a field
 * operator registering people back-to-back must not be thrown out of the
 * form), the dedup-hit outcome, and the unconfigured-domain no-op.
 *
 * The RJSF shim, the fixture config, and the render helper come from
 * `./publicRegistrationView.testHelpers` — shared with
 * `PublicRegistrationView.signals-cta.test.tsx`, which exercises the same
 * two config gates that decide whether this hand-off is armed at all.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, act } from '@testing-library/react';
import {
  RjsfShim,
  CFG,
  SIGNALS_URL,
  renderPublicRegistrationView,
} from './publicRegistrationView.testHelpers';

// jsdom does not implement scrollIntoView; the error banner's focus effect
// calls it whenever state transitions to 'error'.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

vi.mock('@/components/forms/RjsfThemed', () => ({ RjsfThemedForm: RjsfShim }));

// Config drives the hand-off entirely; each test supplies its own payload.
const cfgMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@/hooks/useAggregatorConfig', () => ({
  useAggregatorConfig: () => ({ data: cfgMock.value }),
  DEFAULT_AGGREGATOR_CONFIG: cfgMock.value,
}));

// Pull the view after mocks register.
import { PublicRegistrationView } from '@/app/[org]/[slug]/PublicRegistrationView';

/**
 * Render the public registration view for one link shape. Everything the
 * hand-off depends on comes from the mocked config; the props here only
 * select which form surface renders and which mode/domain the link declares.
 */
function renderView(opts: {
  domain: string;
  registrationMode: string | null;
  submissionShape: 'account_only' | 'account_and_profile';
}) {
  return renderPublicRegistrationView(PublicRegistrationView, opts);
}

/**
 * Render the view, stub the submit POST, and drive one submit to completion
 * so the green success panel is on screen.
 *
 * @param opts.status - HTTP status the stubbed submit returns (409 for a
 *   dedup hit, which the view treats as a success outcome, not an error).
 * @param opts.outcome - `passed` (new registration) or `skipped` (dedup hit).
 */
async function submitSuccessfully(opts: {
  domain: string;
  registrationMode: string | null;
  submissionShape?: 'account_only' | 'account_and_profile';
  status?: number;
  outcome?: 'passed' | 'skipped';
}): Promise<void> {
  const status = opts.status ?? 200;
  const outcome = opts.outcome ?? 'passed';
  fetchMock.mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => ({ submission_id: 'SUB-0001', outcome }),
  } as unknown as Response);
  renderView({
    domain: opts.domain,
    registrationMode: opts.registrationMode,
    submissionShape: opts.submissionShape ?? 'account_and_profile',
  });
  await act(async () => {
    fireEvent.submit(screen.getByTestId('rjsf-shim'));
  });
}

/**
 * Advance the fake clock by whole seconds, one second per `act` flush.
 *
 * The countdown re-arms its `setTimeout` from an effect, so the next tick's
 * timer does not exist until React has rendered the previous one. A single
 * `advanceTimersByTime(3000)` would therefore fire exactly one tick; each
 * second needs its own flush.
 */
async function tick(seconds: number): Promise<void> {
  for (let i = 0; i < seconds; i += 1) {
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
  }
}

const assign = vi.fn();
const fetchMock = vi.fn();
let originalLocation: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  assign.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
});

describe('Signals post-submit redirect', () => {
  it('counts down from 3 and then navigates to the domain URL', async () => {
    cfgMock.value = CFG;
    await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
    expect(screen.getByText(/Redirecting to Signals in 3/)).toBeInTheDocument();
    await tick(1);
    expect(screen.getByText(/Redirecting to Signals in 2/)).toBeInTheDocument();
    await tick(1);
    expect(screen.getByText(/Redirecting to Signals in 1/)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    await tick(1);
    expect(assign).toHaveBeenCalledWith(SIGNALS_URL);
  });

  it('navigates immediately when Continue to Signals is clicked', async () => {
    cfgMock.value = CFG;
    await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
    fireEvent.click(screen.getByRole('button', { name: /continue to signals/i }));
    expect(assign).toHaveBeenCalledWith(SIGNALS_URL);
    // Clicking cancels the tick, so a slow or blocked navigation cannot be
    // followed by a second `assign` when the countdown would have hit zero.
    await tick(5);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('never shows a bare "0" countdown, even at the terminal tick', async () => {
    cfgMock.value = CFG;
    await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
    // Advance through 3 -> 2 -> 1 -> 0. The 3rd tick both lands the state at
    // 0 AND fires `assign` in the same effect pass, so the render at
    // `redirectIn === 0` is the one left on screen afterwards.
    await tick(3);
    expect(assign).toHaveBeenCalledWith(SIGNALS_URL);
    expect(screen.queryByText(/Redirecting to Signals in 0/)).toBeNull();
    // The number-less copy takes over instead of a bare "0".
    const notice = screen.getByText(/Redirecting to Signals/);
    expect(notice.textContent).not.toMatch(/\d/);
  });

  it('announces once via a static live region and hides the ticking number from AT', async () => {
    cfgMock.value = CFG;
    await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
    const announcement = screen.getByText(/You'll be taken to Signals shortly/);
    expect(announcement).toHaveAttribute('aria-live', 'polite');
    // The number lives outside the live region and is hidden from AT — three
    // announcements in three seconds would interrupt each other (WCAG 4.1.3).
    const counter = screen.getByText(/Redirecting to Signals in 3/);
    expect(counter).toHaveAttribute('aria-hidden', 'true');
    expect(counter).not.toBe(announcement);
    expect(announcement).not.toHaveTextContent(/\d/);
    // Ticking must not re-announce: the live region's text is unchanged.
    const announced = announcement.textContent;
    await tick(1);
    expect(screen.getByText(/Redirecting to Signals in 2/)).toBeInTheDocument();
    expect(screen.getByText(/You'll be taken to Signals shortly/).textContent).toBe(announced);
  });

  it('mounts the aria-live region even when no hand-off is configured, empty, before it could ever be populated', async () => {
    // No `signals_ui_urls` entry for `seeker` — the countdown never arms, so
    // if the live region were still gated on `redirectIn !== null` (the
    // pre-fix behaviour) it would never enter the DOM at all. Screen readers
    // only pick up mutations inside a region that was already present, so
    // proving the element exists independently of the countdown arming is
    // the discriminating check for the mount-order fix.
    cfgMock.value = { ...CFG, signals_ui_urls: {} };
    await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
    const region = document.querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region).toHaveClass('sr-only');
    expect(region?.textContent).toBe('');
  });

  it('populates the pre-mounted live region once the countdown arms', async () => {
    cfgMock.value = CFG;
    await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
    const region = document.querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region?.textContent).toMatch(/You'll be taken to Signals shortly/);
  });

  it('cancels the countdown when Register another is clicked', async () => {
    cfgMock.value = CFG;
    await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
    fireEvent.click(screen.getByRole('button', { name: /register another/i }));
    await tick(5);
    expect(assign).not.toHaveBeenCalled();
    expect(screen.queryByText(/Redirecting to Signals/)).toBeNull();
    // The form is back, so the operator can key in the next person.
    expect(screen.getByTestId('rjsf-shim')).toBeInTheDocument();
  });

  it('redirects on a dedup hit (outcome=skipped) too', async () => {
    cfgMock.value = CFG;
    await submitSuccessfully({
      domain: 'seeker',
      registrationMode: 'form',
      status: 409,
      outcome: 'skipped',
    });
    expect(screen.getByText(/Redirecting to Signals in 3/)).toBeInTheDocument();
    await tick(3);
    expect(assign).toHaveBeenCalledWith(SIGNALS_URL);
  });

  it('keeps the plain success panel when the domain has no configured URL', async () => {
    cfgMock.value = { ...CFG, signals_ui_urls: {} };
    await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
    // The success panel itself still renders — only the hand-off is absent.
    expect(screen.getByRole('button', { name: /register another/i })).toBeInTheDocument();
    expect(screen.queryByText(/Redirecting to Signals/)).toBeNull();
    expect(screen.queryByRole('button', { name: /continue to signals/i })).toBeNull();
    expect(screen.queryByText(/You'll be taken to Signals shortly/)).toBeNull();
    await tick(5);
    expect(assign).not.toHaveBeenCalled();
  });
});
