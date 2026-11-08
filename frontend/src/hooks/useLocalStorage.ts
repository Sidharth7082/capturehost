import { useCallback, useState } from 'react';

/**
 * useState that survives a reload. Used for the sidebar collapse state so the
 * layout does not jump back to expanded on every navigation.
 * Reads lazily and tolerates a corrupt/absent value.
 */
export function useLocalStorage<T>(key: string, initialValue: T): [T, (value: T) => void] {
  const [stored, setStored] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? initialValue : (JSON.parse(raw) as T);
    } catch {
      return initialValue;
    }
  });

  const setValue = useCallback(
    (value: T) => {
      setStored(value);
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // Private mode / quota exceeded: the in-memory value still works.
      }
    },
    [key],
  );

  return [stored, setValue];
}
