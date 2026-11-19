'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useVoiceBots } from '@/hooks/useOnboarding';
import { languageNames } from '@/lib/language-names';
import type { ListVoiceBotsResponse, VoiceBotOption } from '@/services/onboarding.service';

/** Props for {@link VoiceBotPicker}. */
export interface VoiceBotPickerProps {
  /** Domain the link is for; the bot list is fetched per domain. */
  domain: string;
  /** The chosen bot key, or `null` when none is picked (the API then stores the default). */
  value: string | null;
  /** Called with the picked bot's key, including when it is the default. */
  onChange: (key: string | null) => void;
  /** Shows the "choose a voice bot" message; set by the form after a blocked submit. */
  showChoiceRequired?: boolean;
}

/**
 * Whether the coordinator must pick a bot: several bots serve the domain, the
 * instance names no default and nothing is chosen yet.
 *
 * @param data - The bot list for the domain, or undefined while loading.
 * @param value - The chosen bot key, or `null` for none.
 * @returns True when the link cannot be created until a bot is chosen.
 */
export function needsVoiceBotChoice(
  data: ListVoiceBotsResponse | undefined,
  value: string | null,
): boolean {
  return (
    data !== undefined &&
    data.voice_bots.length > 1 &&
    data.default_voice_bot_key === null &&
    value === null
  );
}

/** One bot's name, number, languages and description. */
function BotDetails({ bot }: Readonly<{ bot: VoiceBotOption }>) {
  const locale = useLocale();
  return (
    <span className="flex min-w-0 flex-col">
      <span className="flex flex-wrap items-baseline gap-x-3 text-[14px] text-(--bd-fg)">
        <span className="font-semibold">{bot.display_name}</span>
        <span className="font-mono text-[12.5px] text-ink-500">{bot.phone}</span>
        <span className="text-[12.5px] text-ink-500">{languageNames(bot.languages, locale)}</span>
      </span>
      {bot.description && <span className="text-[12.5px] text-ink-400">{bot.description}</span>}
    </span>
  );
}

/**
 * Voice bot choice for a link that offers voice.
 *
 * Several bots show as radio rows with the instance default preselected; one
 * bot shows as read-only text; none shows a note. Picking any bot, the default
 * included, reports its key, so the link stays on that bot if the default changes.
 */
export function VoiceBotPicker({
  domain,
  value,
  onChange,
  showChoiceRequired = false,
}: Readonly<VoiceBotPickerProps>) {
  const t = useTranslations('onboarding.create_link');
  const bots = useVoiceBots(domain);

  if (bots.isError) {
    return (
      <p role="alert" className="text-[12.5px] text-rose-700">
        {t('voice_bot_load_failed')}
      </p>
    );
  }
  if (!bots.data) return null;

  const { voice_bots: list, default_voice_bot_key: defaultKey } = bots.data;
  const selected = value ?? defaultKey;

  return (
    <fieldset className="md:col-span-2 min-w-0">
      <legend className="bd-label">{t('voice_bot_label')}</legend>
      {list.length === 0 && <p className="text-[12.5px] text-ink-500">{t('voice_bot_none')}</p>}
      {list.length === 1 && list[0] && <BotDetails bot={list[0]} />}
      {list.length > 1 && (
        <div className="flex flex-col gap-2">
          {list.map((bot) => (
            <label
              key={bot.key}
              className="flex cursor-pointer items-start gap-2.5 rounded-[10px] border border-(--bd-border) px-3 py-2"
            >
              <input
                type="radio"
                name={`voice-bot-${domain}`}
                className="mt-1 shrink-0"
                checked={selected === bot.key}
                onChange={() => onChange(bot.key)}
              />
              <BotDetails bot={bot} />
            </label>
          ))}
        </div>
      )}
      {showChoiceRequired && needsVoiceBotChoice(bots.data, value) && (
        <p role="alert" className="mt-1.5 text-[12.5px] text-rose-700">
          {t('voice_bot_choice_required')}
        </p>
      )}
    </fieldset>
  );
}
