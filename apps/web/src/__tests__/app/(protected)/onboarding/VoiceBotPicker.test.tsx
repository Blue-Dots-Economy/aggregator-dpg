/**
 * Tests for `VoiceBotPicker.tsx` — the coordinator's voice bot choice in the
 * create-link form. The bot list comes from `onboardingService.listVoiceBots`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { makeQueryClient, renderWithProviders } from '@/__tests__/test-utils';
import type { VoiceBotOption } from '@/services/onboarding.service';

const { listVoiceBots } = vi.hoisted(() => ({ listVoiceBots: vi.fn() }));
vi.mock('@/services/onboarding.service', () => ({ onboardingService: { listVoiceBots } }));

import { VoiceBotPicker } from '@/app/(protected)/onboarding/_components/VoiceBotPicker';

const BOT_HI: VoiceBotOption = {
  key: 'up-hi',
  display_name: 'UP Rozgar Sahayak',
  phone: '+91 12345 67890',
  languages: ['hi'],
  description: 'Hindi, for seekers in UP',
};
const BOT_KN: VoiceBotOption = {
  key: 'ka-kn',
  display_name: 'UP Kannada Bot',
  phone: '+91 98765 43210',
  languages: ['kn'],
};

function renderPicker(props: { domain?: string; value?: string | null; onChange?: () => void }) {
  const onChange = props.onChange ?? vi.fn();
  renderWithProviders(
    <NextIntlClientProvider locale="en" messages={{ onboarding: messages.onboarding }}>
      <VoiceBotPicker
        domain={props.domain ?? 'seeker'}
        value={props.value ?? null}
        onChange={onChange}
      />
    </NextIntlClientProvider>,
    { queryClient: makeQueryClient() },
  );
  return onChange;
}

describe('<VoiceBotPicker />', () => {
  beforeEach(() => {
    listVoiceBots.mockReset();
  });

  it('lists each bot as a radio with name, number, languages and description, default preselected', async () => {
    listVoiceBots.mockResolvedValue({
      voice_bots: [BOT_HI, BOT_KN],
      default_voice_bot_key: 'ka-kn',
    });
    renderPicker({});
    const radios = await screen.findAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(screen.getByText('UP Rozgar Sahayak')).toBeInTheDocument();
    expect(screen.getByText('+91 12345 67890')).toBeInTheDocument();
    expect(screen.getByText('Hindi')).toBeInTheDocument();
    expect(screen.getByText('Hindi, for seekers in UP')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /UP Kannada Bot/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /UP Rozgar Sahayak/ })).not.toBeChecked();
    expect(listVoiceBots).toHaveBeenCalledWith('seeker');
  });

  it('shows language codes as names in the current locale', async () => {
    listVoiceBots.mockResolvedValue({
      voice_bots: [BOT_HI, BOT_KN],
      default_voice_bot_key: 'ka-kn',
    });
    renderPicker({});
    await screen.findAllByRole('radio');
    expect(screen.getByText('Hindi')).toBeInTheDocument();
    expect(screen.getByText('Kannada')).toBeInTheDocument();
    expect(screen.queryByText('hi')).not.toBeInTheDocument();
  });

  it('shows the choose-a-bot message only when asked, several bots, no default, none chosen', async () => {
    listVoiceBots.mockResolvedValue({ voice_bots: [BOT_HI, BOT_KN], default_voice_bot_key: null });
    const { rerender } = renderWithProviders(
      <NextIntlClientProvider locale="en" messages={{ onboarding: messages.onboarding }}>
        <VoiceBotPicker domain="seeker" value={null} onChange={vi.fn()} />
      </NextIntlClientProvider>,
      { queryClient: makeQueryClient() },
    );
    await screen.findAllByRole('radio');
    expect(screen.queryByText('Choose a voice bot for this link.')).not.toBeInTheDocument();
    rerender(
      <NextIntlClientProvider locale="en" messages={{ onboarding: messages.onboarding }}>
        <VoiceBotPicker domain="seeker" value={null} onChange={vi.fn()} showChoiceRequired />
      </NextIntlClientProvider>,
    );
    expect(await screen.findByText('Choose a voice bot for this link.')).toBeInTheDocument();
    rerender(
      <NextIntlClientProvider locale="en" messages={{ onboarding: messages.onboarding }}>
        <VoiceBotPicker domain="seeker" value="up-hi" onChange={vi.fn()} showChoiceRequired />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByText('Choose a voice bot for this link.')).not.toBeInTheDocument();
  });

  it('reports a non-default pick by its key', async () => {
    const user = userEvent.setup();
    listVoiceBots.mockResolvedValue({
      voice_bots: [BOT_HI, BOT_KN],
      default_voice_bot_key: 'ka-kn',
    });
    const onChange = renderPicker({});
    await user.click(await screen.findByRole('radio', { name: /UP Rozgar Sahayak/ }));
    expect(onChange).toHaveBeenCalledWith('up-hi');
  });

  it('reports the default bot by its key, not null, when picked after another bot', async () => {
    const user = userEvent.setup();
    listVoiceBots.mockResolvedValue({
      voice_bots: [BOT_HI, BOT_KN],
      default_voice_bot_key: 'ka-kn',
    });
    const onChange = renderPicker({ value: 'up-hi' });
    await user.click(await screen.findByRole('radio', { name: /UP Kannada Bot/ }));
    expect(onChange).toHaveBeenCalledWith('ka-kn');
    expect(onChange).not.toHaveBeenCalledWith(null);
  });

  it('shows the chosen bot as selected', async () => {
    listVoiceBots.mockResolvedValue({
      voice_bots: [BOT_HI, BOT_KN],
      default_voice_bot_key: 'ka-kn',
    });
    renderPicker({ value: 'up-hi' });
    expect(await screen.findByRole('radio', { name: /UP Rozgar Sahayak/ })).toBeChecked();
  });

  it('shows one bot as read-only text with no radios', async () => {
    listVoiceBots.mockResolvedValue({ voice_bots: [BOT_HI], default_voice_bot_key: 'up-hi' });
    renderPicker({});
    expect(await screen.findByText('UP Rozgar Sahayak')).toBeInTheDocument();
    expect(screen.getByText('+91 12345 67890')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('shows the note when no bot is configured', async () => {
    listVoiceBots.mockResolvedValue({ voice_bots: [], default_voice_bot_key: null });
    renderPicker({});
    expect(
      await screen.findByText(
        'No voice bot yet — the link offers Register / sign in until one is configured',
      ),
    ).toBeInTheDocument();
  });

  it('shows a load error rather than the no-bot note when the list fails', async () => {
    listVoiceBots.mockImplementation(async () => {
      throw new Error('boom');
    });
    renderPicker({});
    const el = await screen.findByRole('alert');
    expect(el).toHaveTextContent("Couldn't load the voice bots");
    expect(screen.queryByText(/No voice bot yet/)).not.toBeInTheDocument();
  });

  it('refetches when the domain changes', async () => {
    listVoiceBots.mockResolvedValue({ voice_bots: [BOT_HI], default_voice_bot_key: 'up-hi' });
    const queryClient = makeQueryClient();
    const { rerender } = renderWithProviders(
      <NextIntlClientProvider locale="en" messages={{ onboarding: messages.onboarding }}>
        <VoiceBotPicker domain="seeker" value={null} onChange={vi.fn()} />
      </NextIntlClientProvider>,
      { queryClient },
    );
    await waitFor(() => expect(listVoiceBots).toHaveBeenCalledWith('seeker'));
    rerender(
      <NextIntlClientProvider locale="en" messages={{ onboarding: messages.onboarding }}>
        <VoiceBotPicker domain="provider" value={null} onChange={vi.fn()} />
      </NextIntlClientProvider>,
    );
    await waitFor(() => expect(listVoiceBots).toHaveBeenCalledWith('provider'));
  });
});
