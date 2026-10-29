// Short messages at the bottom right. Call toast() from anywhere; <ToastHost /> (in Shell) shows them.
import { useEffect, useSyncExternalStore } from "react";

export type ToastKind = "info" | "success" | "error";
export interface ToastItem { id: number; message: string; kind: ToastKind }

const SHOW_MS: Record<ToastKind, number> = { info: 4000, success: 4000, error: 7000 };

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

function dismiss(id: number): void {
  items = items.filter((t) => t.id !== id);
  emit();
}

/** Shows a short message. Errors stay longer. */
export function toast(message: string, kind: ToastKind = "info"): void {
  items = [...items, { id: nextId++, message, kind }].slice(-4);
  emit();
}

function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

function ToastView({ item }: { item: ToastItem }) {
  useEffect(() => {
    const t = window.setTimeout(() => dismiss(item.id), SHOW_MS[item.kind]);
    return () => window.clearTimeout(t);
  }, [item.id, item.kind]);
  return (
    <div className={`toast toast-${item.kind}`} role={item.kind === "error" ? "alert" : "status"} onClick={() => dismiss(item.id)}>
      {item.message}
    </div>
  );
}

export function ToastHost() {
  const list = useSyncExternalStore(subscribe, () => items, () => items);
  return <div className="toasts">{list.map((t) => <ToastView key={t.id} item={t} />)}</div>;
}
