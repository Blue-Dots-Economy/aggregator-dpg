import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs');

import { watch } from 'node:fs';
import { startWatcher } from '../fs/watcher.js';

type WatchCallback = () => void;

function mockWatch(): {
  trigger: () => void;
  close: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn();
  let captured: WatchCallback | undefined;

  vi.mocked(watch).mockImplementation((_path: unknown, _opts: unknown, cb: unknown) => {
    captured = cb as WatchCallback;
    return { close } as ReturnType<typeof watch>;
  });

  return {
    trigger: () => {
      if (captured) captured();
    },
    close,
  };
}

describe('startWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it('returns an unsubscribe function', () => {
    mockWatch();
    const onReload = vi.fn().mockResolvedValue(undefined);
    const unsubscribe = startWatcher('/config', 300, onReload);
    expect(typeof unsubscribe).toBe('function');
  });

  it('calls watch with recursive option on the given directory', () => {
    mockWatch();
    const onReload = vi.fn().mockResolvedValue(undefined);
    startWatcher('/some/config', 300, onReload);
    expect(watch).toHaveBeenCalledWith('/some/config', { recursive: true }, expect.any(Function));
  });

  it('calls onReload after debounce settles', async () => {
    const { trigger } = mockWatch();
    const onReload = vi.fn().mockResolvedValue(undefined);
    startWatcher('/config', 300, onReload);

    trigger();
    expect(onReload).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('coalesces rapid events into a single reload', async () => {
    const { trigger } = mockWatch();
    const onReload = vi.fn().mockResolvedValue(undefined);
    startWatcher('/config', 300, onReload);

    trigger();
    trigger();
    trigger();

    await vi.runAllTimersAsync();
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe closes the watcher', () => {
    const { close } = mockWatch();
    const onReload = vi.fn().mockResolvedValue(undefined);
    const unsubscribe = startWatcher('/config', 300, onReload);

    unsubscribe();
    expect(close).toHaveBeenCalledOnce();
  });

  it('unsubscribe cancels a pending debounce timer', async () => {
    const { trigger } = mockWatch();
    const onReload = vi.fn().mockResolvedValue(undefined);
    const unsubscribe = startWatcher('/config', 300, onReload);

    trigger();
    unsubscribe();

    await vi.runAllTimersAsync();
    expect(onReload).not.toHaveBeenCalled();
  });

  it('calling unsubscribe twice does not throw', () => {
    mockWatch();
    const onReload = vi.fn().mockResolvedValue(undefined);
    const unsubscribe = startWatcher('/config', 300, onReload);
    expect(() => {
      unsubscribe();
      unsubscribe();
    }).not.toThrow();
  });
});
