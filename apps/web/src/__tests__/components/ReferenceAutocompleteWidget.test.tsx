/**
 * Unit tests for ReferenceAutocompleteWidget and its dataset helpers.
 *
 * Two things carry real risk here. The dataset is fetched from a URL assembled
 * out of runtime config, so `resolveDatasetId` picking the wrong region means a
 * 404 and a silently list-less field; and the two supported dataset shapes are
 * flattened by hand, so a shape regression turns a working picker into an empty
 * one with no error anywhere. Both degrade to a plain text input rather than
 * failing loudly, which is friendly in production and invisible without tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FormRuntimeConfigProvider } from '@/lib/FormRuntimeConfigProvider';
import { makeQueryClient } from '@/__tests__/test-utils';
import {
  ReferenceAutocompleteWidget,
  flattenReferenceDataset,
  resolveDatasetId,
} from '@/components/forms/custom-widgets/ReferenceAutocompleteWidget';

describe('resolveDatasetId', () => {
  it('scopes the colleges source to the configured region', () => {
    expect(resolveDatasetId('colleges', 'ka')).toBe('colleges-ka');
    expect(resolveDatasetId('colleges', 'up')).toBe('colleges-up');
  });

  it('passes any other source id through verbatim', () => {
    expect(resolveDatasetId('trades', 'ka')).toBe('trades');
  });
});

describe('flattenReferenceDataset', () => {
  it('flattens the hierarchical state/district/organization shape', () => {
    const flat = flattenReferenceDataset({
      states: [
        {
          name: 'Karnataka',
          districts: [{ name: 'Bengaluru', organizations: [{ name: 'Govt ITI Bengaluru' }] }],
        },
      ],
    });

    expect(flat).toEqual([
      { name: 'Govt ITI Bengaluru', district: 'Bengaluru', state: 'Karnataka' },
    ]);
  });

  it('prefers an organization’s own district/state over its parent nodes', () => {
    const flat = flattenReferenceDataset({
      states: [
        {
          name: 'Karnataka',
          districts: [
            {
              name: 'Bengaluru',
              organizations: [{ name: 'Outpost ITI', district: 'Ramanagara', state: 'KA' }],
            },
          ],
        },
      ],
    });

    expect(flat[0]).toEqual({ name: 'Outpost ITI', district: 'Ramanagara', state: 'KA' });
  });

  it('accepts an already-flat array', () => {
    expect(flattenReferenceDataset([{ name: 'Govt ITI', district: 'Mysuru' }])).toEqual([
      { name: 'Govt ITI', district: 'Mysuru' },
    ]);
  });

  it('drops entries with no string name instead of emitting a nameless option', () => {
    expect(flattenReferenceDataset([{ district: 'Mysuru' }, { name: 42 }])).toEqual([]);
  });

  it('returns an empty list for an empty or shapeless dataset', () => {
    expect(flattenReferenceDataset([])).toEqual([]);
    expect(flattenReferenceDataset({})).toEqual([]);
  });
});

const DATASET = [
  { name: 'Government ITI Jayanagar', district: 'Bengaluru', state: 'Karnataka' },
  { name: 'Government Polytechnic Mysuru', district: 'Mysuru', state: 'Karnataka' },
];

/** The query client for the current test; mounts in one test share it. */
let queryClient: QueryClient;

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <FormRuntimeConfigProvider value={{ collegeDataset: 'ka' }}>
        {children}
      </FormRuntimeConfigProvider>
    </QueryClientProvider>
  );
}

/**
 * A source id unique to each test.
 *
 * Loaded datasets are cached in the query client, keyed by dataset id, so
 * re-mounting the form does not refetch a list that runs to megabytes. Each
 * test gets a fresh client, and a distinct id keeps the fetch URLs apart in
 * assertions. The cache itself is covered by its own test below.
 */
let sourceCounter = 0;
function uniqueSource(): string {
  sourceCounter += 1;
  return `test-dataset-${sourceCounter}`;
}

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    id: 'root_itiInstitute',
    value: '',
    required: false,
    disabled: false,
    readonly: false,
    onChange: vi.fn(),
    label: 'College / Institute Name',
    schema: {},
    options: { source: uniqueSource(), subtitleFields: ['district'] },
    uiSchema: {},
    registry: { formContext: {} } as never,
    rawErrors: [],
    ...overrides,
  };
}

describe('ReferenceAutocompleteWidget', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    queryClient = makeQueryClient();
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => DATASET });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the region-scoped dataset from the app’s own /reference/ path by default', async () => {
    render(
      <Wrapper>
        <ReferenceAutocompleteWidget
          {...(makeProps({ options: { source: 'colleges' } }) as never)}
        />
      </Wrapper>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/reference/colleges-ka.json');
  });

  it('fetches from an absolute REFERENCE_BASE_URL when one is configured', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <FormRuntimeConfigProvider
          value={{ collegeDataset: 'up', referenceBaseUrl: 'https://cdn.example/lists' }}
        >
          <ReferenceAutocompleteWidget
            {...(makeProps({ options: { source: 'colleges' } }) as never)}
          />
        </FormRuntimeConfigProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://cdn.example/lists/colleges-up.json');
  });

  it('reuses the loaded list on a later mount instead of refetching a multi-megabyte list', async () => {
    const source = uniqueSource();
    const props = makeProps({ options: { source } });

    const first = render(
      <Wrapper>
        <ReferenceAutocompleteWidget {...(props as never)} />
      </Wrapper>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    first.unmount();

    render(
      <Wrapper>
        <ReferenceAutocompleteWidget {...(props as never)} />
      </Wrapper>,
    );

    // Still one: the second mount is served from the cache.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('suggests matching institutes and shows the configured subtitle', async () => {
    render(
      <Wrapper>
        <ReferenceAutocompleteWidget {...(makeProps() as never)} />
      </Wrapper>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'jayanagar' } });

    const option = await screen.findByRole('option');
    expect(option).toHaveTextContent('Government ITI Jayanagar');
    expect(option).toHaveTextContent('Bengaluru');
  });

  it('keeps an option row when a longer query filters out the rows before it', async () => {
    render(
      <Wrapper>
        <ReferenceAutocompleteWidget {...(makeProps() as never)} />
      </Wrapper>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'government' } });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    const rowBefore = screen.getByText('Government Polytechnic Mysuru').closest('li');

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'government p' } });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    expect(screen.getByText('Government Polytechnic Mysuru').closest('li')).toBe(rowBefore);
  });

  it('lists two options that share a name', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { name: 'Government ITI', district: 'Mysuru' },
        { name: 'Government ITI', district: 'Mysuru' },
      ],
    });
    render(
      <Wrapper>
        <ReferenceAutocompleteWidget {...(makeProps() as never)} />
      </Wrapper>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'government' } });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
  });

  it('stores the plain option name, so the field stays a simple string', async () => {
    const onChange = vi.fn();
    render(
      <Wrapper>
        <ReferenceAutocompleteWidget {...(makeProps({ onChange }) as never)} />
      </Wrapper>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'jayanagar' } });
    fireEvent.mouseDown(await screen.findByRole('option'));

    expect(onChange).toHaveBeenLastCalledWith('Government ITI Jayanagar');
  });

  it('shows a value the form sets from outside, such as a prefill', () => {
    const props = makeProps();
    const { rerender } = render(
      <Wrapper>
        <ReferenceAutocompleteWidget {...(props as never)} />
      </Wrapper>,
    );
    rerender(
      <Wrapper>
        <ReferenceAutocompleteWidget
          {...({ ...props, value: 'Government ITI Jayanagar' } as never)}
        />
      </Wrapper>,
    );
    expect(screen.getByRole('combobox')).toHaveValue('Government ITI Jayanagar');
  });

  it('keeps what the user typed while the form value matches it', () => {
    const props = makeProps();
    const { rerender } = render(
      <Wrapper>
        <ReferenceAutocompleteWidget {...(props as never)} />
      </Wrapper>,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'gov' } });
    rerender(
      <Wrapper>
        <ReferenceAutocompleteWidget {...({ ...props, value: 'gov' } as never)} />
      </Wrapper>,
    );
    expect(screen.getByRole('combobox')).toHaveValue('gov');
  });

  it('lists nothing for a single-character query', async () => {
    // A one-character query matches a large share of a 100k-entry dataset;
    // rendering that is neither useful nor cheap.
    render(
      <Wrapper>
        <ReferenceAutocompleteWidget {...(makeProps() as never)} />
      </Wrapper>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'g' } });

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('degrades to a plain text input when the response is 200 but not JSON', async () => {
    // A misconfigured COLLEGE_DATASET asks for a region the deployment does
    // not ship. Next serves its catch-all app shell for that path — 200, with
    // 34 KB of text/html — rather than a 404, so `res.ok` is true and the
    // failure only surfaces when `res.json()` rejects. Confirmed against the
    // deployed aggregator. The widget must still fall back to a usable text
    // input rather than leaving an unhandled rejection behind.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    });
    const onChange = vi.fn();
    render(
      <Wrapper>
        <ReferenceAutocompleteWidget {...(makeProps({ onChange }) as never)} />
      </Wrapper>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'anything typed' } });

    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith('anything typed');
  });

  it('fetches again on a later mount after a failed load', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    const props = makeProps();
    const first = render(
      <Wrapper>
        <ReferenceAutocompleteWidget {...(props as never)} />
      </Wrapper>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // Let the failed load settle before unmounting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    first.unmount();

    render(
      <Wrapper>
        <ReferenceAutocompleteWidget {...(props as never)} />
      </Wrapper>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'jayanagar' } });
    expect(await screen.findByRole('option')).toHaveTextContent('Government ITI Jayanagar');
  });

  it('cancels the dataset request when the field unmounts before it loads', async () => {
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise(() => {});
    });
    const { unmount } = render(
      <Wrapper>
        <ReferenceAutocompleteWidget {...(makeProps() as never)} />
      </Wrapper>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('degrades to a plain text input when the dataset fails to load', async () => {
    // Deliberate: a missing reference file must not block a registrant from
    // typing their institute name and submitting.
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    const onChange = vi.fn();
    render(
      <Wrapper>
        <ReferenceAutocompleteWidget {...(makeProps({ onChange }) as never)} />
      </Wrapper>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'anything typed' } });

    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith('anything typed');
  });
});
