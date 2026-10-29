// The Settings popover, anchored to the rail: Appearance, Scripts for Affinity and About, each on its own card.
import { useEffect, useRef, useState, type ComponentType } from "react";
import { api, type ScriptsInfo } from "../api.js";
import { platform, type ThemeMode } from "../platform.js";
import { CopyIcon, InfoIcon, MonitorIcon, MoonIcon, SunIcon } from "../shell/icons.js";
import { toast } from "../shell/Toast.js";
import { openAbout } from "./About.js";
import { overlay } from "./overlay.js";

const open = overlay(false);

export const useSettingsOpen = open.use;
export function toggleSettings(): void { open.set(!open.get()); }
export function closeSettings(): void { open.set(false); }

/** What GET /api/scripts says, read when a panel that needs it opens. */
export type ScriptsState = { status: "loading" } | { status: "ready"; info: ScriptsInfo } | { status: "error"; message: string };

export function useScripts(): ScriptsState {
  const [state, setState] = useState<ScriptsState>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    api.scripts().then(
      (info) => { if (alive) setState({ status: "ready", info }); },
      (e: unknown) => { if (alive) setState({ status: "error", message: e instanceof Error ? e.message : String(e) }); },
    );
    return () => { alive = false; };
  }, []);
  return state;
}

/** Copies the Geo – Connect script. True when it reached the clipboard. */
export async function copyConnect(scripts: ScriptsState): Promise<boolean> {
  if (scripts.status !== "ready") return false;
  try {
    await platform.copyText(scripts.info.loader);
    toast("Geo – Connect copied.", "success");
    return true;
  } catch {
    toast("Couldn't copy to the clipboard.", "error");
    return false;
  }
}

/** The folder Affinity's scripts live in, with the platform's separator. */
const scriptsFolder = (home: string) => `${home.replace(/[\\/]+$/, "")}${home.includes("\\") ? "\\" : "/"}affinity`;

export const COPY_STEPS = "Then in Affinity: Window ▸ Scripting ▸ Script Editor, New script, paste, Run. Save it so you can run it from the Scripts panel next time.";

const THEMES: Array<{ id: ThemeMode; label: string; Icon: ComponentType<{ size?: number }> }> = [
  { id: "light", label: "Light", Icon: SunIcon },
  { id: "dark", label: "Dark", Icon: MoonIcon },
  { id: "system", label: "System", Icon: MonitorIcon },
];

function Appearance() {
  const [mode, setMode] = useState<ThemeMode | null>(null);
  useEffect(() => { platform.settings().then((s) => setMode(s.appearance), () => setMode("system")); }, []);

  const choose = (m: ThemeMode) => {
    setMode(m);
    platform.setTheme(m).catch((e) => console.warn(e));
    platform.saveSettings({ appearance: m }).catch(() => toast("Couldn't remember the appearance for next time.", "error"));
  };

  return (
    <div className="settings-card">
      <div className="settings-label" id="appearance-label">Appearance</div>
      <div className="segmented settings-segmented" role="radiogroup" aria-labelledby="appearance-label">
        {THEMES.map(({ id, label, Icon }) => (
          <button key={id} type="button" role="radio" aria-checked={mode === id} className={mode === id ? "is-on" : ""}
            onClick={() => choose(id)}>
            <Icon size={15} />{label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Scripts() {
  const scripts = useScripts();
  const [copied, setCopied] = useState(false);
  return (
    <div className="settings-card">
      <div className="settings-label">Scripts for Affinity</div>
      <button type="button" className="btn" disabled={scripts.status !== "ready"}
        onClick={() => { void copyConnect(scripts).then((ok) => { if (ok) setCopied(true); }); }}>
        <CopyIcon size={15} />Copy Geo – Connect
      </button>
      {copied && <p className="help">{COPY_STEPS}</p>}
      {scripts.status === "loading" && <p className="help">Checking the scripts…</p>}
      {scripts.status === "error" && <p className="help help-bad">{scripts.message}</p>}
      {scripts.status === "ready" && (scripts.info.installed
        ? <p className="help">Scripts installed in {scriptsFolder(scripts.info.home)}</p>
        : <p className="help help-bad">Scripts not found. Reinstall AffinityGeo.</p>)}
      {scripts.status === "ready" && scripts.info.scriptsNote && <p className="help">{scripts.info.scriptsNote}</p>}
    </div>
  );
}

export function SettingsHost() {
  const shown = open.use();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeSettings(); };
    // A click outside closes it; the rail's Settings button toggles it itself.
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (box.current?.contains(t) || t?.closest?.("[data-settings-toggle]")) return;
      closeSettings();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onDown); };
  }, [shown]);

  if (!shown) return null;
  return (
    <div ref={box} className="settings-popover" role="dialog" aria-label="Settings">
      <Appearance />
      <Scripts />
      <div className="settings-card">
        <button type="button" className="settings-row" onClick={() => { closeSettings(); openAbout(); }}>
          <InfoIcon size={16} />About AffinityGeo
        </button>
      </div>
    </div>
  );
}
