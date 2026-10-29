// The first-run checklist: a card in the corner until Affinity is set up. Done remembers it; Skip hides it for this launch.
import { useEffect, useState, type ReactNode } from "react";
import { platform } from "../platform.js";
import { CheckIcon, CopyIcon } from "../shell/icons.js";
import { toast } from "../shell/Toast.js";
import { getApp, useApp } from "../store.js";
import { copyConnect, useScripts } from "./Settings.js";

/** Hidden for the rest of this launch (Skip for now, Done, or not needed at start). */
let hiddenThisLaunch = false;

/** For tests: a fresh launch. */
export function resetFirstRun(): void { hiddenThisLaunch = false; }

function Step({ done, children }: { done: boolean; children: ReactNode }) {
  return (
    <li className={`firstrun-step${done ? " is-done" : ""}`} data-done={String(done)}>
      <span className="firstrun-tick" role="img" aria-label={done ? "Done" : "Not done yet"}>{done && <CheckIcon size={12} strokeWidth={2.4} />}</span>
      <div className="firstrun-text">{children}</div>
    </li>
  );
}

function FirstRun({ onHide }: { onHide: () => void }) {
  const { connection } = useApp();
  const scripts = useScripts();
  const [copied, setCopied] = useState(false);
  const connected = connection.connected;

  const done = () => {
    platform.saveSettings({ firstRunDone: true }).catch(() => toast("Couldn't remember this for next time.", "error"));
    onHide();
  };

  return (
    <section className="firstrun" role="region" aria-label="Getting started">
      <h2 className="firstrun-title">Getting started</h2>
      <p className="help">Three steps to connect AffinityGeo to Affinity. You only do this once.</p>
      {scripts.status === "ready" && scripts.info.scriptsNote && <p className="help">{scripts.info.scriptsNote}</p>}
      <ol className="firstrun-steps">
        {/* Connecting proves the folder was allowed: the script runs from there. */}
        <Step done={connected}>In Affinity, open Settings ▸ Scripting and allow C:\AffinityGeo under File System Access.</Step>
        <Step done={copied || connected}>
          Copy Geo – Connect, paste it into a new script in the Script Editor and run it.
          <button type="button" className="btn btn-small" disabled={scripts.status !== "ready"}
            onClick={() => { void copyConnect(scripts).then((ok) => { if (ok) setCopied(true); }); }}>
            <CopyIcon size={14} />Copy Geo – Connect
          </button>
        </Step>
        <Step done={connected}>The light at the bottom turns green.</Step>
      </ol>
      <div className="firstrun-buttons">
        <button type="button" className="btn" onClick={onHide}>Skip for now</button>
        <button type="button" className="btn" onClick={done}>Done</button>
      </div>
    </section>
  );
}

/**
 * Mounted once by App. Decides at start, once the settings are read and the first connection check has
 * finished: shown while the flag isn't set and Affinity isn't connected.
 */
export function FirstRunHost() {
  const { connectionChecked } = useApp();
  const [done, setDone] = useState<boolean | null>(null); // the stored flag, once read
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (hiddenThisLaunch) return;
    let alive = true;
    platform.settings().then((s) => { if (alive) setDone(s.firstRunDone); }, (e: unknown) => console.warn(e));
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (hiddenThisLaunch || done === null || !connectionChecked || shown) return;
    if (done || getApp().connection.connected) { hiddenThisLaunch = true; return; }
    setShown(true);
  }, [done, connectionChecked, shown]);

  if (!shown) return null;
  return <FirstRun onHide={() => { hiddenThisLaunch = true; setShown(false); }} />;
}
