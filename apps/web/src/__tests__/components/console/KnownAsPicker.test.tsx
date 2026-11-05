/**
 * Unit tests for KnownAsPicker: the parent owner's choice of an
 * organisation's "known as" value.
 *
 * Covers: the choices from the parent's list and the Aggregator fallback, the hint for a top-level organisation, the current
 * value kept when it is not a choice, the key sent on save, nothing sent while
 * unchanged, a newer value from the page, and the API's message for a value
 * that is not allowed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type { KnownAsEntry, Org } from '@aggregator-dpg/shared-primitives/user-org';
import { chooseOption } from '@/__tests__/test-utils';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { KnownAsPicker } from '@/components/console/KnownAsPicker';

const ID = '00000000-0000-4000-8000-0000000000c1';
const m = messages.console.org;

type PickerOrg = Pick<Org, 'id' | 'known_as' | 'known_as_name' | 'parent_name' | 'depth'>;

const ORG: PickerOrg = {
  id: ID,
  known_as: 'district',
  known_as_name: 'District',
  parent_name: 'Karnataka',
  depth: 2,
};

const OPTIONS: KnownAsEntry[] = [
  { key: 'district', name: 'District', default: true },
  { key: 'block', name: 'Block' },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const picker = (org: PickerOrg, parentValues: KnownAsEntry[]) => (
  <NextIntlClientProvider locale="en" messages={messages}>
    <KnownAsPicker org={org} parentValues={parentValues} />
  </NextIntlClientProvider>
);

const select = () => screen.getByLabelText(m.known_as);
const save = () => screen.getByRole('button', { name: m.save });
/** Opens the dropdown, lists its option labels in order, and closes it again. */
const optionNames = async () => {
  fireEvent.click(select());
  const names = (await screen.findAllByRole('option')).map((o) => o.textContent);
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
  return names;
};

describe('<KnownAsPicker />', () => {
  const original = global.fetch;
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = original;
  });

  it("offers the parent's values, with the current one chosen", async () => {
    render(picker(ORG, OPTIONS));
    expect(select()).toHaveTextContent('District');
    expect(await optionNames()).toEqual(['District', 'Block']);
    expect(
      screen.getByText('Choose from the values Karnataka has set for the organisations under it.'),
    ).toBeInTheDocument();
    expect(save()).toBeDisabled();
  });

  it("uses the network's hint for a top-level organisation", () => {
    render(picker({ ...ORG, depth: 1, parent_name: 'Blue Dots' }, OPTIONS));
    expect(screen.getByText(m.known_as_pick_hint_network)).toBeInTheDocument();
    expect(screen.queryByText(/Blue Dots has set/)).toBeNull();
  });

  it('keeps the current value when it is not among the choices', async () => {
    render(picker({ ...ORG, known_as: 'aggregator', known_as_name: 'Aggregator' }, OPTIONS));
    expect(select()).toHaveTextContent('Aggregator');
    expect(await optionNames()).toEqual(['Aggregator', 'District', 'Block']);
  });

  it('offers only Aggregator when the parent has no values', async () => {
    render(picker({ ...ORG, known_as: 'aggregator', known_as_name: 'Aggregator' }, []));
    expect(select()).toHaveTextContent('Aggregator');
    expect(await optionNames()).toEqual(['Aggregator']);
  });

  it('keeps a current value that is not Aggregator when the parent has no values', async () => {
    render(picker(ORG, []));
    expect(select()).toHaveTextContent('District');
    expect(await optionNames()).toEqual(['District', 'Aggregator']);
  });

  it('shows the key when the current value has no name', async () => {
    render(picker({ ...ORG, known_as: 'old_key', known_as_name: null }, OPTIONS));
    expect((await optionNames())[0]).toBe('old_key');
  });

  it('sends the chosen key and refreshes the page', async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      json({ id: ID, known_as: 'block', known_as_name: 'Block' }),
    );
    render(picker(ORG, OPTIONS));
    await chooseOption(select(), 'Block');
    fireEvent.click(save());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/org/known-as/${ID}`,
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ known_as: 'block' }) }),
    );
    expect(screen.getByRole('status')).toHaveTextContent(m.saved);
    expect(save()).toBeDisabled();
  });

  it('takes a newer value from the page', () => {
    const { rerender } = render(picker(ORG, OPTIONS));
    rerender(picker({ ...ORG, known_as: 'block', known_as_name: 'Block' }, OPTIONS));
    expect(select()).toHaveTextContent('Block');
  });

  it('shows the API message when the value is not allowed', async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      json({ error: { code: 'SCHEMA_VALIDATION', fields: { known_as: 'invalid' } } }, 400),
    );
    render(picker(ORG, OPTIONS));
    await chooseOption(select(), 'Block');
    fireEvent.click(save());
    expect(await screen.findByText(messages.console.errors.known_as_invalid)).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});
