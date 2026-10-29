// The Maps screen: the map list, the Map view or the Gallery, the inspector, and Send with its summary.
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { MapCanvas, type LonLat, type MapCanvasMode } from "../map/MapCanvas.js";
import { useAreaPreview } from "../map/useAreaPreview.js";
import { Inspector, Section } from "../shell/Inspector.js";
import { GalleryIcon, MapsIcon } from "../shell/icons.js";
import { Shell } from "../shell/Shell.js";
import { toast } from "../shell/Toast.js";
import type { TopBarProps } from "../shell/TopBar.js";
import { getActions, getApp, useApp } from "../store.js";
import { Gallery } from "./Gallery.js";
import { MapInspector } from "./MapInspector.js";
import { MapList } from "./MapList.js";
import { SendProgressPanel, SendSummary, useSend } from "./SendSummary.js";
import { nextMapName } from "./sizes.js";
import { patchMap, refreshAfterChange } from "./status.js";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The lime button's label: "Send all changed" with nothing selected, else "Send to Affinity" (with the count from 2). */
export function sendLabel(selected: number): string {
  if (selected === 0) return "Send all changed";
  return selected === 1 ? "Send to Affinity" : `Send to Affinity (${selected})`;
}

/** A click selects one map; Shift/Ctrl adds or removes it. */
export function nextSelection(current: readonly string[], id: string, additive: boolean): string[] {
  if (!additive) return [id];
  return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
}

function ViewToggle() {
  const { view, setView } = useApp();
  return (
    <div className="segmented view-toggle" role="group" aria-label="View">
      <button type="button" aria-label="Show map" title="Map" aria-pressed={view === "map"} className={view === "map" ? "is-on" : ""}
        onClick={() => setView("map")}><MapsIcon size={16} /></button>
      <button type="button" aria-label="Show gallery" title="Gallery" aria-pressed={view === "gallery"} className={view === "gallery" ? "is-on" : ""}
        onClick={() => setView("gallery")}><GalleryIcon size={16} /></button>
    </div>
  );
}

export interface MapsScreenProps {
  /** The project buttons (New, Open…, Save project) from App. The screen adds Send. */
  topBar?: Omit<TopBarProps, "onSend" | "sendLabel" | "sendDisabled">;
}

export function MapsScreen({ topBar }: MapsScreenProps) {
  useAreaPreview();
  const { project, preview, selectedMapIds, view, select, setView } = useApp();
  const [mode, setMode] = useState<MapCanvasMode>("browse");
  const { sending, summary, progress, send, close } = useSend();

  // Escape leaves add or pick mode.
  useEffect(() => {
    if (mode === "browse") return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMode("browse"); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);

  const maps = project?.maps ?? [];
  const selected = maps.filter((m) => selectedMapIds.includes(m.id));
  const one = selected.length === 1 ? selected[0]! : null;

  // "Pick on map" belongs to one map: a different selection ends it.
  const oneId = one?.id ?? null;
  useEffect(() => { setMode((m) => (m === "pick" ? "browse" : m)); }, [oneId]);

  const save = (p: Promise<unknown>) => { p.catch((e) => toast(message(e), "error")); };

  function startMode(next: MapCanvasMode): void {
    if (view !== "map") setView("map");
    setMode((m) => (m === next ? "browse" : next));
  }

  async function addAt(centre: LonLat): Promise<void> {
    setMode("browse");
    const names = getApp().project?.maps.map((m) => m.name) ?? [];
    try {
      const m = await api.addMap({ name: nextMapName(names), centre });
      await getActions().refreshProject().catch(() => undefined); // before select: a refresh drops unknown ids
      select([m.id]);
    } catch (e) {
      toast(message(e), "error");
      refreshAfterChange();
    }
  }

  function pickAt(centre: LonLat): void {
    setMode("browse");
    if (one) save(patchMap(one.id, { centre }));
  }

  const toolbar = mode === "add" ? (
    <>
      <span>Click the map where the new map's centre goes.</span>
      <button type="button" className="btn btn-small" onClick={() => setMode("browse")}>Cancel</button>
    </>
  ) : mode === "pick" && one ? (
    <>
      <span>Click the map where the centre of '{one.name}' goes.</span>
      <button type="button" className="btn btn-small" onClick={() => setMode("browse")}>Cancel</button>
    </>
  ) : undefined;

  const inspector = !project ? undefined : one ? (
    <Inspector>
      <MapInspector key={one.id} map={one} style={project.style} sending={sending} onPickCentre={() => startMode("pick")} onSend={(o) => { void send(o); }} />
    </Inspector>
  ) : (
    <Inspector>
      <Section chip="Maps">
        <p className="help">
          {selected.length > 1
            ? `${selected.length} maps selected. Send to Affinity sends them one after the other.`
            : "Select a map in the list or on the map to change it. Shift-click to select several."}
        </p>
      </Section>
    </Inspector>
  );

  return (
    <Shell
      topBar={{
        ...topBar,
        onSend: () => { void send(selectedMapIds.length ? { mapIds: [...selectedMapIds] } : {}); },
        sendLabel: sendLabel(selectedMapIds.length),
        sendDisabled: sending || !maps.length,
      }}
      toolbar={toolbar}
      inspector={inspector}
    >
      {project && (
        <div className="maps-screen">
          <MapList adding={mode === "add"} onAdd={() => startMode("add")}
            onSelect={(id, additive) => select(nextSelection(getApp().selectedMapIds, id, additive))} />
          <div className="maps-stage">
            {view === "map" ? (
              <>
                <MapCanvas
                  preview={preview.data ?? null}
                  style={project.style}
                  maps={maps}
                  selectedIds={selectedMapIds}
                  mode={mode === "pick" && !one ? "browse" : mode}
                  onSelect={select}
                  onMove={(id, centre) => save(patchMap(id, { centre }))}
                  onRotate={(id, rotationDeg) => save(patchMap(id, { rotationDeg }))}
                  onAdd={(centre) => { void addAt(centre); }}
                  onPick={pickAt}
                />
                {preview.status === "none" && <div className="map-canvas-note">No map data yet. Fetch it on the Area screen.</div>}
                {preview.status === "loading" && <div className="map-canvas-note">Loading the map…</div>}
              </>
            ) : (
              <Gallery onSelect={(id, additive) => select(nextSelection(getApp().selectedMapIds, id, additive))} />
            )}
            <ViewToggle />
            {progress ? <SendProgressPanel progress={progress} /> : summary && <SendSummary summary={summary} onClose={close} />}
          </div>
        </div>
      )}
    </Shell>
  );
}
