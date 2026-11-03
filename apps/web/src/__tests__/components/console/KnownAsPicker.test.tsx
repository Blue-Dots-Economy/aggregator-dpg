/**
 * Unit tests for KnownAsPicker: the parent owner's choice of an
 * organisation's "known as" value.
 *
 * Covers: the choices, the current value kept when it is not a choice, the
 * key sent on save, nothing sent while unchanged, a newer value from the
 * page, and the API's message for a value that is not allowed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type { KnownAsEntry, Org } from '@aggregator-dpg/shared-primitives/user-org';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { KnownAsPicker } from '@/components/console/KnownAsPicker';

const ID = '00000000-0000-4000-8000-0000000000c1';
const m = messages.console.org;

type PickerOrg = Pick<Org, 'id' | 'known_as' | 'known_as_name' | 'parent_name'>;

const ORG: PickerOrg = {
  id: ID,
  known_as: 'district',
  known_as_name: 'District',
  parent_name: 'Karnataka',
};

const OPTIONS: KnownAsEntry[] = [
  { key: 'district', name: 'District', default: true },
  { key: 'block', name: 'Block' },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const picker = (org: PickerOrg, options: KnownAsEntry[]) => (
  <NextIntlClientProvider locale="en" messages={messages}>
    <KnownAsPicker org={org} options={options} />
  </NextIntlClientProvider>
);

const select = () => screen.getByLabelText(m.known_as);
const save = () => screen.getByRole('button', { name: m.save });
const optionNames = () => screen.getAllByRole('option').map((o) => o.textContent);

describe('<KnownAsPicker />', () => {
  const original = global.fetch;
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = original;
  });

  it("offers the parent's values, with the current one chosen", () => {
    render(picker(ORG, OPTIONS));
    expect(select()).toHaveValue('district');
    expect(optionNames()).toEqual(['District', 'Block']);
    expect(
      screen.getByText('Choose from the values Karnataka has set for the organisations under it.'),
    ).toBeInTheDocument();
    expect(save()).toBeDisabled();
  });

  it('keeps the current value when it is not among the choices', () => {
    render(picker({ ...ORG, known_as: 'aggregator', known_as_name: 'Aggregator' }, OPTIONS));
    expect(select()).toHaveValue('aggregator');
    expect(optionNames()).toEqual(['Aggregator', 'District', 'Block']);
  });

  it('shows the key when the current value has no name', () => {
    render(picker({ ...ORG, known_as: 'old_key', known_as_name: null }, OPTIONS));
    expect(optionNames()[0]).toBe('old_key');
  });

  it('sends the chosen key and refreshes the page', async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      json({ id: ID, known_as: 'block', known_as_name: 'Block' }),
    );
    render(picker(ORG, OPTIONS));
    fireEvent.change(select(), { target: { value: 'block' } });
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
    expect(select()).toHaveValue('block');
  });

  it('shows the API message when the value is not allowed', async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      json({ error: { code: 'SCHEMA_VALIDATION', fields: { known_as: 'invalid' } } }, 400),
    );
    render(picker(ORG, OPTIONS));
    fireEvent.change(select(), { target: { value: 'block' } });
    fireEvent.click(save());
    expect(await screen.findByText(messages.console.errors.known_as_invalid)).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});
