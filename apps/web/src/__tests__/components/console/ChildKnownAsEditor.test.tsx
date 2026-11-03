/**
 * Unit tests for ChildKnownAsEditor: the "known as" values an organisation
 * defines for the organisations under it.
 *
 * Covers: the empty state, saved rows with their default, adding, renaming
 * and removing rows (saved keys sent back, new rows without a key), the
 * default choice, the row limit, name checks before sending, the saved list
 * from the API, an error, a changed list from the page, and the same list
 * in a new object (unsaved edits kept).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import {
  KNOWN_AS_MAX_VALUES,
  KNOWN_AS_NAME_MAX,
  type ChildKnownAs,
} from '@aggregator-dpg/shared-primitives/user-org';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { ChildKnownAsEditor } from '@/components/console/ChildKnownAsEditor';

const ORG = '00000000-0000-4000-8000-0000000000b1';
const m = messages.console.org;

const SAVED: ChildKnownAs = [
  { key: 'district', name: 'District', default: true },
  { key: 'block', name: 'Block' },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function renderIt(values: ChildKnownAs = SAVED) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ChildKnownAsEditor orgId={ORG} values={values} />
    </NextIntlClientProvider>,
  );
}

const save = () => screen.getByRole('button', { name: m.save });
const nameField = (n: number) => screen.getByLabelText(`Name of value ${n}`);
const defaults = () => screen.getAllByRole('radio', { name: m.child_known_as_default });

/** The JSON body of the first PATCH sent. */
function sentBody(): unknown {
  const call = vi.mocked(global.fetch).mock.calls[0];
  return JSON.parse(String((call?.[1] as { body: string }).body));
}

describe('<ChildKnownAsEditor />', () => {
  const original = global.fetch;
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = original;
  });

  it('shows the empty state and the notes when there are no values', () => {
    renderIt([]);
    expect(screen.getByText(m.child_known_as_empty)).toBeInTheDocument();
    expect(screen.getByText(m.child_known_as_default_note)).toBeInTheDocument();
    expect(screen.getByText(m.child_known_as_remove_note)).toBeInTheDocument();
    expect(save()).toBeDisabled();
  });

  it('shows the saved values with their default, and no key field', () => {
    renderIt();
    expect(nameField(1)).toHaveValue('District');
    expect(nameField(1)).toHaveAttribute('maxLength', String(KNOWN_AS_NAME_MAX));
    expect(nameField(2)).toHaveValue('Block');
    expect(defaults()[0]).toBeChecked();
    expect(defaults()[1]).not.toBeChecked();
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
    expect(save()).toBeDisabled();
  });

  it('sends saved keys back, a new row without a key, and the new default', async () => {
    const after = [
      { key: 'district', name: 'Zone' },
      { key: 'block', name: 'Block' },
      { key: 'ward', name: 'Ward', default: true },
    ];
    vi.mocked(global.fetch).mockResolvedValue(json({ id: ORG, child_known_as: after }));
    renderIt();
    fireEvent.change(nameField(1), { target: { value: 'Zone' } });
    fireEvent.click(screen.getByRole('button', { name: m.child_known_as_add }));
    fireEvent.change(nameField(3), { target: { value: '  Ward ' } });
    fireEvent.click(defaults()[2]!);
    fireEvent.click(save());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/org/child-known-as/${ORG}`,
      expect.objectContaining({ method: 'PATCH' }),
    );
    expect(sentBody()).toEqual({
      values: [
        { key: 'district', name: 'Zone' },
        { key: 'block', name: 'Block' },
        { name: 'Ward', default: true },
      ],
    });
    expect(screen.getByRole('status')).toHaveTextContent(m.saved);
    expect(save()).toBeDisabled();
  });

  it('removes a row and clears the default when it was the default', async () => {
    vi.mocked(global.fetch).mockResolvedValue(json({ id: ORG, child_known_as: [SAVED[1]] }));
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: 'Remove District' }));
    expect(screen.getByRole('radio', { name: m.child_known_as_no_default })).toBeChecked();
    fireEvent.click(save());
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(sentBody()).toEqual({ values: [{ key: 'block', name: 'Block' }] });
  });

  it('sends no default when "No default" is chosen', async () => {
    vi.mocked(global.fetch).mockResolvedValue(json({ id: ORG, child_known_as: [] }));
    renderIt();
    fireEvent.click(screen.getByRole('radio', { name: m.child_known_as_no_default }));
    fireEvent.click(save());
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(sentBody()).toEqual({
      values: [
        { key: 'district', name: 'District' },
        { key: 'block', name: 'Block' },
      ],
    });
  });

  it('refuses an empty or repeated name before sending', () => {
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: m.child_known_as_add }));
    fireEvent.click(save());
    expect(screen.getByText(m.child_known_as_name_required)).toBeInTheDocument();
    fireEvent.change(nameField(3), { target: { value: 'district ' } });
    fireEvent.click(save());
    expect(screen.getByText(m.child_known_as_name_repeated)).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('stops adding rows at the limit', () => {
    const full = Array.from({ length: KNOWN_AS_MAX_VALUES }, (_, i) => ({
      key: `v_${i}`,
      name: `Value ${i}`,
    }));
    renderIt(full);
    expect(screen.getByRole('button', { name: m.child_known_as_add })).toBeDisabled();
    expect(
      screen.getByText(`You can have up to ${KNOWN_AS_MAX_VALUES} values.`),
    ).toBeInTheDocument();
  });

  it('shows the API message when the save fails', async () => {
    vi.mocked(global.fetch).mockResolvedValue(json({ error: { code: 'FORBIDDEN' } }, 403));
    renderIt();
    fireEvent.change(nameField(2), { target: { value: 'Taluk' } });
    fireEvent.click(save());
    expect(await screen.findByText(messages.console.errors.forbidden)).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('takes a newer list from the page', () => {
    const { rerender } = renderIt();
    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ChildKnownAsEditor orgId={ORG} values={[{ key: 'ward', name: 'Ward' }]} />
      </NextIntlClientProvider>,
    );
    expect(nameField(1)).toHaveValue('Ward');
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });

  it('keeps unsaved edits when the page passes the same list in a new object', () => {
    const { rerender } = renderIt();
    fireEvent.change(nameField(2), { target: { value: 'Mandal' } });
    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ChildKnownAsEditor orgId={ORG} values={SAVED.map((e) => ({ ...e }))} />
      </NextIntlClientProvider>,
    );
    expect(nameField(2)).toHaveValue('Mandal');
    expect(save()).toBeEnabled();
  });
});
