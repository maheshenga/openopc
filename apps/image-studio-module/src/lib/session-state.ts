import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

type SessionStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function getSessionStorage(): SessionStorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readSessionValue<T>(
  key: string,
  fallback: T,
  isValid: (value: unknown) => value is T = (value): value is T => true,
): T {
  const storage = getSessionStorage();
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(key);
    if (raw === null) return fallback;
    const value: unknown = JSON.parse(raw);
    return isValid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function useSessionState<T>(
  key: string,
  initialValue: T,
  isValid: (value: unknown) => value is T = (value): value is T => true,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => readSessionValue(key, initialValue, isValid));

  useEffect(() => {
    const storage = getSessionStorage();
    if (!storage) return;
    const timer = setTimeout(() => {
      try {
        storage.setItem(key, JSON.stringify(value));
      } catch {
        // A full or restricted session store should not block the workspace.
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [key, value]);

  return [value, setValue];
}
