// The left rail: the four screens, with Guide and Settings pinned to the bottom.
import type { ComponentType } from "react";
import { SCREEN_LABELS, useApp, type Screen } from "../store.js";
import { AreaIcon, DataIcon, GuideIcon, MapsIcon, SettingsIcon, StyleIcon } from "./icons.js";

const SCREENS: Array<{ id: Screen; Icon: ComponentType }> = [
  { id: "area", Icon: AreaIcon }, { id: "maps", Icon: MapsIcon }, { id: "style", Icon: StyleIcon }, { id: "data", Icon: DataIcon },
];

export interface RailProps {
  /** Opens the Guide page for the current screen. The item is dimmed without it. */
  onGuide?: () => void;
  onSettings?: () => void;
  settingsOpen?: boolean;
}

export function Rail({ onGuide, onSettings, settingsOpen = false }: RailProps) {
  const { screen, setScreen } = useApp();
  return (
    <nav className="rail" aria-label="Screens">
      <div className="rail-group">
        {SCREENS.map(({ id, Icon }) => (
          <button key={id} type="button" className={`rail-item${screen === id ? " is-selected" : ""}`}
            aria-current={screen === id ? "page" : undefined} onClick={() => setScreen(id)}>
            <Icon /><span>{SCREEN_LABELS[id]}</span>
          </button>
        ))}
      </div>
      <div className="rail-group">
        <button type="button" className="rail-item" disabled={!onGuide} onClick={onGuide}>
          <GuideIcon /><span>Guide</span>
        </button>
        <button type="button" className={`rail-item${settingsOpen ? " is-selected" : ""}`} disabled={!onSettings} data-settings-toggle=""
          aria-expanded={onSettings ? settingsOpen : undefined} onClick={onSettings}>
          <SettingsIcon /><span>Settings</span>
        </button>
      </div>
    </nav>
  );
}
