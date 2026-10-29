// Fetching data from OpenStreetMap: the shared busy panel and the hook that runs a refresh with an elapsed timer.
import { useEffect, useRef, useState } from "react";
import { api, type RefreshResult } from "../api.js";
import { toast } from "../shell/Toast.js";
import { getActions } from "../store.js";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type FetchState =
  | { status: "idle" }
  | { status: "busy" }
  | { status: "error"; message: string }
  | { status: "done"; changed: RefreshResult["changed"] };

/** "Fetching from OpenStreetMap… 12 s", with the reassurance underneath. */
export function FetchPanel({ seconds }: { seconds: number }) {
  return (
    <div className="busy-panel" role="status">
      <span className="spinner" aria-hidden="true" />
      <div>
        <div>{`Fetching from OpenStreetMap… ${seconds} s`}</div>
        <div className="muted">Large areas can take up to a minute.</div>
      </div>
    </div>
  );
}

/** Runs api.refresh() and keeps the project in step. `run()` resolves true when the data arrived. */
export function useFetchData() {
  const [state, setState] = useState<FetchState>({ status: "idle" });
  const [seconds, setSeconds] = useState(0);
  const started = useRef(0);
  const busy = state.status === "busy";

  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - started.current) / 1000)), 1000);
    return () => clearInterval(id);
  }, [busy]);

  async function run(): Promise<boolean> {
    started.current = Date.now();
    setSeconds(0);
    setState({ status: "busy" });
    let result: RefreshResult;
    try {
      result = await api.refresh();
    } catch (e) {
      setState({ status: "error", message: message(e) });
      return false;
    }
    // The data arrived. If re-reading the project fails, that is a different problem from a failed fetch.
    try {
      await getActions().refreshProject();
    } catch (e) {
      toast(message(e), "error");
    }
    setState({ status: "done", changed: result.changed });
    return true;
  }

  return { state, seconds, run };
}
