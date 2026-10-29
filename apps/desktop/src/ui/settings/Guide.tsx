// The Guide page for a screen: what it's for, three things to do, one good-to-know. Opened by ? or the rail's Guide.
import { useEffect, useId } from "react";
import type { Screen } from "../store.js";
import { CloseIcon } from "../shell/icons.js";
import { GUIDE } from "./guide-text.js";
import { overlay } from "./overlay.js";

const open = overlay<Screen | null>(null);

export function openGuide(screen: Screen): void { open.set(screen); }
export function closeGuide(): void { open.set(null); }

export function GuideHost() {
  const screen = open.use();
  const titleId = useId();

  useEffect(() => {
    if (!screen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeGuide(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen]);

  if (!screen) return null;
  const page = GUIDE[screen];
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closeGuide(); }}>
      <div className="dialog guide" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="guide-head">
          <h2 id={titleId} className="dialog-title">{page.title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={closeGuide}><CloseIcon size={16} /></button>
        </div>
        <p className="guide-intro">{page.intro}</p>
        <ol className="guide-actions">
          {page.actions.map((a) => <li key={a}>{a}</li>)}
        </ol>
        <div className="guide-note">
          <span className="chip">Good to know</span>
          <p>{page.goodToKnow}</p>
        </div>
      </div>
    </div>
  );
}
