// The window layout: top bar, left rail, the screen in the middle, an optional inspector, and the status bar.
import type { ReactNode } from "react";
import { useApp } from "../store.js";
import { AboutHost } from "../settings/About.js";
import { GuideHost, openGuide } from "../settings/Guide.js";
import { SettingsHost, toggleSettings, useSettingsOpen } from "../settings/Settings.js";
import { ConfirmHost } from "./Confirm.js";
import { Rail, type RailProps } from "./Rail.js";
import { StatusBar } from "./StatusBar.js";
import { ToastHost } from "./Toast.js";
import { TopBar, type TopBarProps } from "./TopBar.js";

/** Rail props are optional: Guide and Settings open the app's own panels unless a caller passes its own. */
export interface ShellProps extends RailProps {
  /** The current screen's content (the canvas area). */
  children?: ReactNode;
  /** The context toolbar under the top bar. */
  toolbar?: ReactNode;
  /** The right inspector's sections; no column when absent. */
  inspector?: ReactNode;
  topBar?: TopBarProps;
}

export function Shell({ children, toolbar, inspector, topBar, ...rail }: ShellProps) {
  const { screen } = useApp();
  const settingsOpen = useSettingsOpen();
  const guide = () => openGuide(screen);
  return (
    <div className="app">
      <TopBar {...topBar} />
      <div className="app-body">
        <Rail onGuide={guide} onSettings={toggleSettings} settingsOpen={settingsOpen} {...rail} />
        <main className="workspace">
          {toolbar && <div className="toolbar">{toolbar}</div>}
          <div className="canvas">{children}</div>
        </main>
        {inspector && <aside className="inspector">{inspector}</aside>}
      </div>
      <StatusBar />
      <SettingsHost />
      <GuideHost />
      <AboutHost />
      <ConfirmHost />
      <ToastHost />
    </div>
  );
}
