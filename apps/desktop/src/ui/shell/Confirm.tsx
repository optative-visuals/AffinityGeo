// A centred question dialog. Call confirm() from anywhere; <ConfirmHost /> (in Shell) shows it.
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

export interface ConfirmButton {
  label: string;
  /** What confirm() resolves with. Defaults to the label. */
  value?: string;
  /** "primary" is the lime button (at most one); "danger" is red text. */
  kind?: "primary" | "danger" | "default";
}

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  /** In display order. A plain string is a default button. */
  buttons: Array<string | ConfirmButton>;
  /** Show it ahead of any question already waiting (which comes back once this one is answered). */
  front?: boolean;
}

/** What confirm() resolves with when the dialog is dismissed with Escape. */
export const DISMISSED = "";

interface Pending extends ConfirmOptions { resolve: (v: string) => void }

let queue: Pending[] = [];
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

/** Asks a question and resolves with the chosen button's value (or label), or DISMISSED ("") on Escape. One at a time. */
export function confirm(opts: ConfirmOptions): Promise<string> {
  return new Promise((resolve) => {
    queue = opts.front ? [{ ...opts, resolve }, ...queue] : [...queue, { ...opts, resolve }];
    emit();
  });
}

function answer(value: string): void {
  const [first, ...rest] = queue;
  if (!first) return;
  queue = rest;
  emit();
  first.resolve(value);
}

const norm = (b: string | ConfirmButton): ConfirmButton => (typeof b === "string" ? { label: b } : b);

export function ConfirmHost() {
  const current = useSyncExternalStore(subscribe, () => queue[0], () => queue[0]);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!current) return;
    const el = dialog.current;
    (el?.querySelector<HTMLButtonElement>(".btn-primary") ?? el?.querySelector<HTMLButtonElement>("button"))?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); answer(DISMISSED); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current]);

  if (!current) return null;
  const buttons = current.buttons.map(norm);
  return (
    <div className="overlay">
      <div ref={dialog} className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title" className="dialog-title">{current.title}</h2>
        {current.body && <div className="dialog-body">{current.body}</div>}
        <div className="dialog-buttons">
          {buttons.map((b) => (
            <button key={b.value ?? b.label} type="button"
              className={`btn${b.kind === "primary" ? " btn-primary" : ""}${b.kind === "danger" ? " btn-danger" : ""}`}
              onClick={() => answer(b.value ?? b.label)}>
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
