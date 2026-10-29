// A tiny shared value with a React hook: which panel is open survives a screen change (each screen has its own Shell).
import { useSyncExternalStore } from "react";

export interface Overlay<T> {
  get(): T;
  set(v: T): void;
  use(): T;
}

export function overlay<T>(initial: T): Overlay<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
  const get = () => value;
  return {
    get,
    set(v) { value = v; for (const l of listeners) l(); },
    use: () => useSyncExternalStore(subscribe, get, get),
  };
}
