import { useCallback, useRef, useState } from 'react';

/**
 * A setting that saves as it changes, and never goes on showing a value the
 * server did not accept.
 *
 * The settings that use this are privacy controls - who can find you, and when
 * friends may ask you for time. Showing "Nobody" while the server still says
 * "Anyone" is worse than an error: the person stops worrying about something
 * that is still happening. So the new value shows while it saves, and if the
 * save fails the last value the server *confirmed* comes back, with `failed`
 * set so the screen can say so.
 *
 * Saves can overlap when someone clicks quickly. Every success updates what is
 * confirmed, but only the newest request decides what is displayed, so an
 * early response landing late cannot overwrite a later choice.
 */
export function useSavedSetting<T>(
  initial: T,
  save: (value: T) => Promise<T>,
): {
  value: T;
  failed: boolean;
  /** Change it, optimistically, and save. */
  change: (next: T) => void;
  /** Adopt a value the server reported, without saving it back. */
  load: (confirmed: T) => void;
} {
  const [value, setValue] = useState(initial);
  const [failed, setFailed] = useState(false);
  const confirmed = useRef(initial);
  const latest = useRef(0);

  const load = useCallback((next: T) => {
    confirmed.current = next;
    setValue(next);
  }, []);

  const change = (next: T): void => {
    latest.current += 1;
    const request = latest.current;
    setValue(next);
    setFailed(false);
    save(next).then(
      (stored) => {
        confirmed.current = stored;
        if (request === latest.current) setValue(stored);
      },
      () => {
        if (request !== latest.current) return;
        setValue(confirmed.current);
        setFailed(true);
      },
    );
  };

  return { value, failed, change, load };
}
