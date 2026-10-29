// The bottom bar: the Affinity connection light on the left, the version (and a downloaded update) on the right.
import { useEffect, useState } from "react";
import { platform } from "../platform.js";
import { useApp } from "../store.js";
import { GlobeIcon } from "./icons.js";

export function StatusBar() {
  const { connection } = useApp();
  const on = connection.connected;
  const [update, setUpdate] = useState<string | null>(null);
  useEffect(() => { platform.onUpdateReady(setUpdate); }, []);
  return (
    <footer className="statusbar">
      <span className="status-connection" role="status"
        title={on ? "The Geo – Connect script is running in Affinity." : "Run the Geo – Connect script in Affinity to connect."}>
        <span data-testid="connection-dot" data-state={on ? "connected" : "disconnected"}
          className={`status-dot ${on ? "is-green" : "is-grey"}`} />
        <span>{on ? "Affinity connected" : "Affinity not connected"}</span>
        {on && connection.busy && <span className="muted"> · drawing…</span>}
      </span>
      <span className="status-right">
        {update && (
          <span className="status-update" title={`AffinityGeo ${update} has downloaded. It installs when you restart.`}>
            <span>Update ready: restart to install</span>
            <button type="button" className="status-link" onClick={() => platform.restartToUpdate()}>Restart</button>
          </span>
        )}
        <span className="status-version"><GlobeIcon size={13} /><span>AffinityGeo {platform.version}</span></span>
      </span>
    </footer>
  );
}
