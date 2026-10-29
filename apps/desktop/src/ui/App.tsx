// The app: the shell, polling, the project buttons and the close guard. Screens plug in here (later tasks).
import { useEffect } from "react";
import { api, pendingRequests } from "./api.js";
import { platform } from "./platform.js";
import { Shell } from "./shell/Shell.js";
import { confirm } from "./shell/Confirm.js";
import { toast } from "./shell/Toast.js";
import { getActions, guardUnsaved, saveProject, saveProjectAs, useApp, useAppPolling } from "./store.js";
import { FirstRunHost } from "./settings/FirstRun.js";
import { MapsScreen } from "./maps/MapsScreen.js";
import { closeSummary, getSendState, useSend } from "./maps/SendSummary.js";
import { AreaScreen } from "./area/AreaScreen.js";
import { NewProjectHost, openNewProject } from "./area/NewProject.js";
import { StyleScreen } from "./style/StyleScreen.js";
import { DataScreen } from "./data/DataScreen.js";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Opens a project file (from the dialog, or a path from the recent list). */
async function openPath(path: string): Promise<void> {
  await api.open(path);
  // A different project: the old project's send summary no longer applies.
  closeSummary();
  await platform.addRecent(path);
  const actions = getActions();
  await actions.refreshProject();
  void actions.refreshStatuses().catch(() => undefined); // the new project's badges, without waiting 5 s
}

/** Not while a send runs: the run belongs to the open project (the buttons are disabled then too). */
const notWhileSending = (fn: () => Promise<void>) => async () => { if (!getSendState().sending) await fn(); };

/** The top bar's project actions. New and the two Opens ask about unsaved changes first. */
export const projectActions = {
  newProject: notWhileSending(() => guardUnsaved(async () => { openNewProject(); })),
  open: notWhileSending(() => guardUnsaved(async () => {
    const path = await platform.openProject();
    if (path) await openPath(path);
  })),
  openRecent: (path: string) => notWhileSending(() => guardUnsaved(() => openPath(path)))(),
  save: async () => { await saveProject(); },
  saveAs: async () => { await saveProjectAs(); },
};

/** True while the close questions are on screen, so repeated close clicks don't stack dialogs. */
let askingToClose = false;

/**
 * The window wants to close: don't drop a change the server is still making, a send that is running,
 * or unsaved changes. The questions go ahead of any already on screen (such as a send's size question).
 */
export async function handleCloseRequest(): Promise<void> {
  if (askingToClose) return;
  askingToClose = true;
  let closing = false;
  try {
    const sending = getSendState().sending;
    if (sending || pendingRequests() > 0) {
      const answer = await confirm({
        title: "AffinityGeo is still working",
        body: sending
          ? "Maps are still being sent to Affinity. If you close now, the rest won't be sent."
          : "A change is still being made. If you close now, it may be lost.",
        buttons: ["Cancel", { label: "Close anyway", kind: "primary" }],
        front: true,
      });
      if (answer !== "Close anyway") return;
    }
    await guardUnsaved(async () => { closing = true; platform.confirmClose(); });
  } catch (e) {
    toast(message(e), "error"); // e.g. the save failed: stay open
  } finally {
    askingToClose = false;
    if (!closing) platform.cancelClose(); // main forgets a pending "restart to update"
  }
}

/** No project open: the way in. */
function NoProject() {
  return (
    <div className="empty">
      <div>
        <h1>No project open</h1>
        <p>Choose New to start a map project, or Open… to carry on with one.</p>
        <button type="button" className="btn btn-primary" onClick={openNewProject}>New project</button>
      </div>
    </div>
  );
}

export function App() {
  useAppPolling();
  const { project, screen, setScreen } = useApp();
  const { sending, send } = useSend();

  useEffect(() => {
    // Close guard: don't drop a change the server is still making, or unsaved changes.
    platform.onCloseRequest(() => { void handleCloseRequest(); });
    // The remembered Appearance (System until chosen).
    platform.settings().then((s) => platform.setTheme(s.appearance)).catch((e) => console.warn(e));
  }, []);

  const run = (fn: () => Promise<void>) => () => { fn().catch((e) => toast(message(e), "error")); };

  // New, Open… and Open Recent wait while a send runs: switching project mid-run would orphan it.
  const projectButtons = {
    onNew: sending ? undefined : run(projectActions.newProject),
    onOpen: sending ? undefined : run(projectActions.open),
    onOpenRecent: sending ? undefined : (path: string) => run(() => projectActions.openRecent(path))(),
    onSave: run(projectActions.save),
    onSaveAs: run(projectActions.saveAs),
  };

  const sendProps = {
    // Away from Maps the map selection can't be seen, so Send always sends every changed map.
    // It goes to Maps, where the progress panel and then the summary show what happened.
    onSend: () => {
      setScreen("maps");
      void send({});
    },
    sendLabel: project ? "Send all changed" : undefined, // no project: the plain "Send to Affinity"
    sendDisabled: sending || !project?.maps.length,
  };

  // Each screen renders the Shell with its own toolbar, inspector and Send.
  let body;
  if (project && screen === "maps") body = <MapsScreen topBar={projectButtons} />;
  else if (project && screen === "area") body = <AreaScreen topBar={{ ...projectButtons, ...sendProps }} />;
  else if (project && screen === "style") body = <StyleScreen topBar={{ ...projectButtons, ...sendProps }} />;
  else if (project && screen === "data") body = <DataScreen topBar={{ ...projectButtons, ...sendProps }} />;
  else body = <Shell topBar={{ ...projectButtons, ...sendProps }}><NoProject /></Shell>;

  return <>{body}<NewProjectHost /><FirstRunHost /></>;
}
