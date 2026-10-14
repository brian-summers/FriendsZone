// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useSavedSetting } from './useSavedSetting.js';

afterEach(cleanup);

/** A save the test resolves or rejects by hand, to control ordering. */
function deferredSaves() {
  const pending: Array<{ resolve: (v: string) => void; reject: () => void }> = [];
  const save = (value: string) =>
    new Promise<string>((resolve, reject) => {
      pending.push({ resolve: () => resolve(value), reject: () => reject(new Error('nope')) });
    });
  return { save, pending };
}

describe('useSavedSetting', () => {
  it('shows the new value while it saves, and keeps it once accepted', async () => {
    const { save, pending } = deferredSaves();
    const { result } = renderHook(() => useSavedSetting('EVERYONE', save));

    act(() => result.current.change('NOBODY'));
    expect(result.current.value).toBe('NOBODY');

    await act(async () => pending[0]!.resolve('NOBODY'));
    expect(result.current.value).toBe('NOBODY');
    expect(result.current.failed).toBe(false);
  });

  it('puts back the confirmed value when a save fails, and says so', async () => {
    // The failure this exists for: "Nobody" on screen, "Anyone" on the server.
    const { save, pending } = deferredSaves();
    const { result } = renderHook(() => useSavedSetting('EVERYONE', save));

    act(() => result.current.change('NOBODY'));
    await act(async () => pending[0]!.reject());

    expect(result.current.value).toBe('EVERYONE');
    expect(result.current.failed).toBe(true);
  });

  it('reverts to a value loaded from the server, not the hook’s first value', async () => {
    const { save, pending } = deferredSaves();
    const { result } = renderHook(() => useSavedSetting('EVERYONE', save));

    act(() => result.current.load('EXACT_HANDLE'));
    act(() => result.current.change('NOBODY'));
    await act(async () => pending[0]!.reject());

    expect(result.current.value).toBe('EXACT_HANDLE');
  });

  it('lets only the newest request decide what is shown', async () => {
    const { save, pending } = deferredSaves();
    const { result } = renderHook(() => useSavedSetting('EVERYONE', save));

    act(() => result.current.change('EXACT_HANDLE'));
    act(() => result.current.change('NOBODY'));

    // The older save lands last-but-one; it must not overwrite the newer choice.
    await act(async () => pending[0]!.resolve('EXACT_HANDLE'));
    expect(result.current.value).toBe('NOBODY');

    // And if the newer one then fails, what comes back is what was confirmed.
    await act(async () => pending[1]!.reject());
    expect(result.current.value).toBe('EXACT_HANDLE');
    expect(result.current.failed).toBe(true);
  });

  it('clears the failure once a later save succeeds', async () => {
    const { save, pending } = deferredSaves();
    const { result } = renderHook(() => useSavedSetting('EVERYONE', save));

    act(() => result.current.change('NOBODY'));
    await act(async () => pending[0]!.reject());
    act(() => result.current.change('NOBODY'));
    await act(async () => pending[1]!.resolve('NOBODY'));

    expect(result.current.failed).toBe(false);
    expect(result.current.value).toBe('NOBODY');
  });
});
