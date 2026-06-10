import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveTiles, type TileDef } from '../tiles';

const DEFAULTS: TileDef[] = [
  { field: 'total_items', label: 'Total Profiles' },
  { field: 'complete_profiles', label: 'Complete Profiles' },
];

const ROLLUP = {
  total_items: 12,
  complete_profiles: 5,
  avg_items_per_user: 1.1666,
  by_status: { new: 4 },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveTiles', () => {
  it('reads config-sourced defs from the rollup in order', () => {
    const defs: TileDef[] = [
      { field: 'avg_items_per_user', label: 'Avg' },
      { field: 'total_items', label: 'Total' },
    ];
    expect(resolveTiles(defs, DEFAULTS, ROLLUP)).toEqual([
      { field: 'avg_items_per_user', label: 'Avg', value: 1.1666 },
      { field: 'total_items', label: 'Total', value: 12 },
    ]);
  });

  it('falls back to defaults when defs is undefined or empty', () => {
    for (const defs of [undefined, [] as TileDef[]]) {
      expect(resolveTiles(defs, DEFAULTS, ROLLUP)).toEqual([
        { field: 'total_items', label: 'Total Profiles', value: 12 },
        { field: 'complete_profiles', label: 'Complete Profiles', value: 5 },
      ]);
    }
  });

  it('renders all tiles as 0 while the rollup is loading', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tiles = resolveTiles(undefined, DEFAULTS, undefined);
    expect(tiles.map((t) => t.value)).toEqual([0, 0]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips tiles whose field is missing from the rollup, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const defs: TileDef[] = [
      { field: 'nope', label: 'Unknown' },
      { field: 'total_items', label: 'Total' },
    ];
    const tiles = resolveTiles(defs, DEFAULTS, ROLLUP);
    expect(tiles).toEqual([{ field: 'total_items', label: 'Total', value: 12 }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"nope"'));
  });

  it('skips object-valued rollup fields instead of rendering them', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const defs: TileDef[] = [{ field: 'by_status', label: 'Bad config' }];
    expect(resolveTiles(defs, DEFAULTS, ROLLUP)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not numeric'));
  });
});
