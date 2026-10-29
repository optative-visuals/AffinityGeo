// Sandboxed preload: exposes window.geoApp and nothing else. Only `electron` can be required here.
import { contextBridge, ipcRenderer } from "electron";
import { IPC, type GeoApp } from "../shared/geo-app.js";

const versionArg = process.argv.find((a) => a.startsWith("--geo-version="));

const geoApp: GeoApp = {
  version: versionArg ? versionArg.slice("--geo-version=".length) : "dev",
  openProject: () => ipcRenderer.invoke(IPC.openProject),
  saveProjectAs: (suggested) => ipcRenderer.invoke(IPC.saveProjectAs, String(suggested)),
  openDataFile: () => ipcRenderer.invoke(IPC.openDataFile),
  copyText: (text) => ipcRenderer.invoke(IPC.copyText, String(text)),
  setTheme: (mode) => ipcRenderer.invoke(IPC.setTheme, mode),
  recent: () => ipcRenderer.invoke(IPC.recent),
  addRecent: (path) => ipcRenderer.invoke(IPC.addRecent, String(path)),
  settings: () => ipcRenderer.invoke(IPC.settings),
  saveSettings: (patch) => ipcRenderer.invoke(IPC.saveSettings, patch),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, String(url)),
  onCloseRequest(cb) {
    ipcRenderer.removeAllListeners(IPC.closeRequest);
    ipcRenderer.on(IPC.closeRequest, () => {
      ipcRenderer.send(IPC.closeAck); // the UI is alive: main stops its fallback timer
      cb();
    });
    ipcRenderer.send(IPC.closeGuardReady);
  },
  confirmClose: () => ipcRenderer.send(IPC.confirmClose),
  cancelClose: () => ipcRenderer.send(IPC.closeCancelled),
  onUpdateReady(cb) {
    ipcRenderer.removeAllListeners(IPC.updateReady);
    ipcRenderer.on(IPC.updateReady, (_e, version) => cb(String(version)));
    // One may have downloaded before the UI was listening (or before a reload).
    void ipcRenderer.invoke(IPC.updateStatus).then((v: unknown) => { if (typeof v === "string") cb(v); });
  },
  restartToUpdate: () => ipcRenderer.send(IPC.restartToUpdate),
};

contextBridge.exposeInMainWorld("geoApp", geoApp);
