// The About dialog: logo, name, tagline, maker, version, licence, the GitHub link and the lime Close.
import { useEffect, useId } from "react";
import { GITHUB_URL } from "../../shared/geo-app.js";
import { platform } from "../platform.js";
import { CodeIcon, PinIcon } from "../shell/icons.js";
import { toast } from "../shell/Toast.js";
import { overlay } from "./overlay.js";

const open = overlay(false);

export function openAbout(): void { open.set(true); }
export function closeAbout(): void { open.set(false); }

export function AboutHost() {
  const shown = open.use();
  const titleId = useId();

  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeAbout(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown]);

  if (!shown) return null;
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closeAbout(); }}>
      <div className="dialog about" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <PinIcon className="about-logo" size={56} strokeWidth={1.4} />
        <h2 id={titleId} className="about-name">AffinityGeo</h2>
        <p className="about-tagline">Wayfinding maps for Affinity</p>
        <p className="about-maker">Optative</p>
        <p className="about-meta">Version {platform.version}</p>
        <p className="about-meta">Licence: GPL-3.0-or-later</p>
        <p className="about-meta">Map data © OpenStreetMap contributors (ODbL)</p>
        <div className="about-buttons">
          <button type="button" className="btn"
            onClick={() => { platform.openExternal(GITHUB_URL).catch(() => toast("Couldn't open the browser.", "error")); }}>
            <CodeIcon size={15} />Open source on GitHub
          </button>
          <button type="button" className="btn btn-primary" onClick={closeAbout}>Close</button>
        </div>
      </div>
    </div>
  );
}
