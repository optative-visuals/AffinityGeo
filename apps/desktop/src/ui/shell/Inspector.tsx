// The right inspector: a column of sections, each headed by a small grey chip.
import type { ReactNode } from "react";

export function Inspector({ children }: { children?: ReactNode }) {
  return <div className="inspector-body">{children}</div>;
}

export interface SectionProps {
  /** The chip label, e.g. "Map", "Size", "Document". */
  chip: string;
  children?: ReactNode;
}

export function Section({ chip, children }: SectionProps) {
  return (
    <section className="inspector-section" aria-label={chip}>
      <span className="chip">{chip}</span>
      <div className="inspector-section-body">{children}</div>
    </section>
  );
}

/** A grey label above its control, with optional muted helper text underneath. */
export function Field({ label, help, children }: { label: string; help?: ReactNode; children?: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {help && <span className="help">{help}</span>}
    </label>
  );
}
