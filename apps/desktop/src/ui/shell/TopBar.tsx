// The top bar: logo, mode pill, project name with the unsaved dot, then the project buttons and the lime Send (lime marks every button that sends to Affinity).
import { useEffect, useRef, useState } from "react";
import { platform } from "../platform.js";
import { SCREEN_LABELS, useApp } from "../store.js";
import { openGuide } from "../settings/Guide.js";
import { ChevronDownIcon, GuideIcon, NewIcon, OpenIcon, PinIcon, SaveAsIcon, SaveIcon, SendIcon } from "./icons.js";

export interface TopBarProps {
  onNew?: () => void;
  onOpen?: () => void;
  /** A project from the Open Recent list (the arrow on Open…). */
  onOpenRecent?: (path: string) => void;
  onSave?: () => void;
  onSaveAs?: () => void;
  onSend?: () => void;
  /** The lime button's label. Defaults to "Send to Affinity". */
  sendLabel?: string;
  /** Extra reason to disable Send (it is always disabled while Affinity isn't connected or is busy). */
  sendDisabled?: boolean;
}

/** The file name of a Windows or POSIX path. */
const fileName = (p: string) => p.split(/[\\/]/).pop() || p;

/** The arrow half of the Open… split button: the recent projects, newest first. */
function RecentMenu({ onOpenRecent }: { onOpenRecent?: (path: string) => void }) {
  const [list, setList] = useState<string[] | null>(null);
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!list) return;
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setList(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setList(null); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [list]);

  const toggle = async () => {
    if (list) { setList(null); return; }
    try { setList(await platform.recent()); } catch { setList([]); }
  };

  return (
    <span className="menu-anchor" ref={box}>
      <button type="button" className="btn split-arrow" aria-label="Open Recent" title="Open Recent" aria-haspopup="menu"
        aria-expanded={!!list} disabled={!onOpenRecent} onClick={() => { void toggle(); }}>
        <ChevronDownIcon size={14} />
      </button>
      {list && (
        <div className="menu" role="menu" aria-label="Open Recent">
          {list.length === 0 && <div className="menu-empty">No recent projects</div>}
          {list.map((p) => (
            <button key={p} type="button" role="menuitem" className="menu-item" title={p}
              onClick={() => { setList(null); onOpenRecent?.(p); }}>
              {fileName(p)}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

export function TopBar({ onNew, onOpen, onOpenRecent, onSave, onSaveAs, onSend, sendLabel = "Send to Affinity", sendDisabled = false }: TopBarProps) {
  const { screen, project, dirty, connection } = useApp();
  const notReady = !connection.connected ? "Affinity isn't connected. Run Geo – Connect in Affinity."
    : connection.busy ? "Affinity is busy drawing. Try again in a moment." : null;
  return (
    <header className="topbar">
      <div className="topbar-left">
        <PinIcon className="logo" size={20} />
        <span className="mode-pill" data-testid="mode-pill" data-screen={screen}>{SCREEN_LABELS[screen]}</span>
        <button type="button" className="icon-btn topbar-help" aria-label={`Guide to the ${SCREEN_LABELS[screen]} screen`}
          title="Guide" onClick={() => openGuide(screen)}>
          <GuideIcon size={16} />
        </button>
        <span className="doc-name">
          {project ? <strong>{project.name}</strong> : <span className="muted">No project</span>}
          {project && dirty && <span className="unsaved-dot" role="img" aria-label="Unsaved changes" title="Unsaved changes" />}
        </span>
      </div>
      <div className="topbar-right">
        <button type="button" className="btn" disabled={!onNew} onClick={onNew}><NewIcon size={15} />New</button>
        <span className="split">
          <button type="button" className="btn split-main" disabled={!onOpen} onClick={onOpen}><OpenIcon size={15} />Open…</button>
          <RecentMenu onOpenRecent={onOpenRecent} />
        </span>
        <button type="button" className="btn" disabled={!onSave || !project} onClick={onSave}><SaveIcon size={15} />Save project</button>
        <button type="button" className="btn" disabled={!onSaveAs || !project} onClick={onSaveAs}><SaveAsIcon size={15} />Save As…</button>
        <button type="button" className="btn btn-primary" disabled={!onSend || !project || !!notReady || sendDisabled}
          title={notReady ?? undefined} onClick={onSend}>
          <SendIcon size={15} />{sendLabel}
        </button>
      </div>
    </header>
  );
}
