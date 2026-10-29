// Inspector inputs that commit on blur or Enter: a number field and a text field.
// Unparsable numbers revert and say "Enter a number"; a server 400 shows its message under the field.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ApiFail } from "../api.js";
import { parseNumber } from "../maps/sizes.js";
import { toast } from "./Toast.js";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Runs a commit; a 400's plain message goes under the field, anything else is a toast. */
async function settle(run: () => unknown, setError: (m: string | null) => void): Promise<boolean> {
  try {
    await run();
    setError(null);
    return true;
  } catch (e) {
    if (e instanceof ApiFail && e.status === 400) setError(e.message);
    else toast(message(e), "error");
    return false;
  }
}

interface Shared {
  label: string;
  /** Muted helper text under the field (replaced by the error while there is one). */
  help?: ReactNode;
  /** Small fixed text inside the field's left edge, e.g. "1:". */
  prefix?: string;
  disabled?: boolean;
}

/** The label, the input and the helper or error line underneath. */
function Frame({ id, label, help, error, prefix, children }: Shared & { id: string; error: string | null; children: ReactNode }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{label}</label>
      {prefix ? <div className="input-prefix"><span aria-hidden="true">{prefix}</span>{children}</div> : children}
      {error ? <span className="help field-error" role="alert">{error}</span> : help ? <span className="help">{help}</span> : null}
    </div>
  );
}

export interface NumberFieldProps extends Shared {
  value: number;
  /** Called with the parsed number when it differs from `value`. A rejected 400 shows its message. */
  onCommit(n: number): unknown;
  /** How the value is shown. Defaults to String. */
  format?: (n: number) => string;
}

export function NumberField({ label, help, prefix, disabled, value, onCommit, format = String }: NumberFieldProps) {
  const id = useId();
  const [text, setText] = useState(() => format(value));
  const [error, setError] = useState<string | null>(null);
  const editing = useRef(false);
  const shown = format(value);

  // Follow the server's value while the person isn't typing.
  useEffect(() => { if (!editing.current) setText(shown); }, [shown]);

  async function commit(): Promise<void> {
    if (!editing.current) return;
    editing.current = false;
    const n = parseNumber(text);
    if (n === null) { setText(shown); setError("Enter a number"); return; }
    if (n === value) { setText(shown); setError(null); return; }
    const ok = await settle(() => onCommit(n), setError);
    if (!ok) setText(shown);
  }

  return (
    <Frame id={id} label={label} help={help} prefix={prefix} error={error}>
      <input id={id} type="text" inputMode="decimal" value={text} disabled={disabled}
        onChange={(e) => { editing.current = true; setText(e.target.value); }}
        onBlur={() => { void commit(); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); void commit(); }
          if (e.key === "Escape") { editing.current = false; setText(shown); setError(null); }
        }} />
    </Frame>
  );
}

export interface TextFieldProps extends Shared {
  value: string;
  onCommit(text: string): unknown;
}

export function TextField({ label, help, prefix, disabled, value, onCommit }: TextFieldProps) {
  const id = useId();
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const editing = useRef(false);

  useEffect(() => { if (!editing.current) setText(value); }, [value]);

  async function commit(): Promise<void> {
    if (!editing.current) return;
    editing.current = false;
    if (text.trim() === value) { setText(value); setError(null); return; }
    const ok = await settle(() => onCommit(text.trim()), setError);
    if (!ok) setText(value);
  }

  return (
    <Frame id={id} label={label} help={help} prefix={prefix} error={error}>
      <input id={id} type="text" value={text} disabled={disabled}
        onChange={(e) => { editing.current = true; setText(e.target.value); }}
        onBlur={() => { void commit(); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); void commit(); }
          if (e.key === "Escape") { editing.current = false; setText(value); setError(null); }
        }} />
    </Frame>
  );
}
