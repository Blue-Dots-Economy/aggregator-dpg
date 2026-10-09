import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { PermissionSetForm } from '@/components/console/PermissionSetForm';

const orgId = '00000000-0000-4000-8000-0000000000b1';

function renderIt(current: string | null) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PermissionSetForm
        orgId={orgId}
        current={current}
        sets={['network', 'super_aggregator', 'aggregator']}
        defaultName="aggregator"
      />
    </NextIntlClientProvider>,
  );
}

const respond = (body: unknown, status: number) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('<PermissionSetForm />', () => {
  const original = global.fetch;
  afterEach(() => {
    global.fetch = original;
  });

  it('offers the default for the organisation type first', () => {
    renderIt(null);
    const select = screen.getByLabelText(messages.console.org.permission_set) as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(select.options[0]).toHaveTextContent('Default (aggregator)');
    expect(select.options).toHaveLength(4);
  });

  it('saves a chosen set', async () => {
    global.fetch = respond({ id: orgId, permission_set: 'super_aggregator' }, 200) as never;
    renderIt(null);
    fireEvent.change(screen.getByLabelText(messages.console.org.permission_set), {
      target: { value: 'super_aggregator' },
    });
    fireEvent.click(screen.getByRole('button', { name: messages.console.org.permission_set_save }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        messages.console.org.permission_set_saved,
      ),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/org/permission-set/${orgId}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ permission_set: 'super_aggregator' }),
      }),
    );
  });

  it('clears back to the default with null', async () => {
    global.fetch = respond({ id: orgId, permission_set: null }, 200) as never;
    renderIt('super_aggregator');
    fireEvent.change(screen.getByLabelText(messages.console.org.permission_set), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: messages.console.org.permission_set_save }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: JSON.stringify({ permission_set: null }) }),
    );
  });

  it('shows a failure', async () => {
    global.fetch = respond({ error: { code: 'PERMISSION_SET_UNKNOWN' } }, 400) as never;
    renderIt(null);
    fireEvent.click(screen.getByRole('button', { name: messages.console.org.permission_set_save }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(messages.console.errors.generic),
    );
  });
});
