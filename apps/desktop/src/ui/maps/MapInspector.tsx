// The inspector for one map: Map / Size / Document / Marker / Actions. Each field PATCHes only its own setting.
import { useEffect, useId, useRef, useState } from "react";
import type { MapSpec, ProjectStyle } from "@affinitygeo/geo-core";
import { SCALE_MAX, SCALE_MIN, scaleToSlider, sliderToScale } from "@affinitygeo/geo-core/view";
import { api } from "../api.js";
import { confirm } from "../shell/Confirm.js";
import { NumberField, TextField } from "../shell/fields.js";
import { Section } from "../shell/Inspector.js";
import { PinIcon } from "../shell/icons.js";
import { toast } from "../shell/Toast.js";
import { getActions, registerPendingEdit } from "../store.js";
import { PAPER, fmtMm, isLandscape, paperFor, paperSize, sizeLabel, upLabel, type PaperId } from "./sizes.js";
import { patchMap } from "./status.js";
import { TargetPicker } from "./TargetPicker.js";

/** The slider waits this long after the last move before it saves. */
export const SLIDER_DEBOUNCE_MS = 300;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fmtDeg = (n: number) => String(Math.round(n * 1e6) / 1e6);
const fmtScale = (n: number) => n.toLocaleString("en-GB");

export interface MapInspectorProps {
  map: MapSpec;
  style: ProjectStyle;
  /** "Pick on map": the canvas's next click sets the centre. */
  onPickCentre(): void;
  /** A send is running: Reset waits for it. */
  sending?: boolean;
  /** Sends this map (reset: true puts hand edits back). */
  onSend(opts: { mapIds: string[]; reset?: boolean }): void;
}

function ScaleControl({ map }: { map: MapSpec }) {
  const sliderId = useId();
  const [draft, setDraft] = useState<number | null>(null);
  const timer = useRef<number | undefined>(undefined);
  /** The slider value still waiting for its debounce, saved at once if the inspector closes first. */
  const pending = useRef<(() => Promise<void>) | null>(null);
  /** Takes the waiting value off the close guard's list once it is saved. */
  const unregister = useRef<(() => void) | null>(null);

  useEffect(() => () => { window.clearTimeout(timer.current); pending.current?.(); }, []);
  // A new value from the server ends the draft.
  useEffect(() => { setDraft(null); }, [map.id, map.scale]);

  const scale = draft ?? map.scale;
  return (
    <>
      <NumberField label="Scale" prefix="1:" value={scale} format={fmtScale}
        help="1:2,500 means 1 cm on paper is 25 m on the ground. Bigger numbers show more area in less detail."
        onCommit={(n) => patchMap(map.id, { scale: n })} />
      <input id={sliderId} className="range" type="range" min={0} max={1000} step={1} aria-label="Scale slider"
        title={`1:${fmtScale(SCALE_MIN)} to 1:${fmtScale(SCALE_MAX)}`}
        value={scaleToSlider(scale)}
        onChange={(e) => {
          const next = sliderToScale(Number(e.target.value));
          setDraft(next);
          window.clearTimeout(timer.current);
          unregister.current?.();
          const save = () => {
            window.clearTimeout(timer.current);
            pending.current = null;
            unregister.current?.();
            unregister.current = null;
            return patchMap(map.id, { scale: next }).then(() => undefined, (err) => { setDraft(null); toast(message(err), "error"); });
          };
          pending.current = save;
          // The close guard and New/Open save it before deciding whether anything is unsaved.
          unregister.current = registerPendingEdit(save);
          timer.current = window.setTimeout(save, SLIDER_DEBOUNCE_MS);
        }} />
    </>
  );
}

function SizeControls({ map }: { map: MapSpec }) {
  const paperId = useId();
  const preset = paperFor(map.sizeMm);
  const landscape = isLandscape(map.sizeMm);
  const setSize = (sizeMm: { width: number; height: number }) => patchMap(map.id, { sizeMm });
  const run = (p: Promise<unknown>) => { p.catch((e) => toast(message(e), "error")); };

  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor={paperId}>Paper</label>
        <select id={paperId} value={preset ?? ""} onChange={(e) => {
          if (e.target.value) run(setSize(paperSize(e.target.value as PaperId, landscape)));
        }}>
          {PAPER.map((p) => <option key={p.id} value={p.id}>{p.id} ({p.w} × {p.h} mm)</option>)}
          <option value="">Custom</option>
        </select>
      </div>
      <div className="segmented" role="group" aria-label="Orientation">
        <button type="button" aria-pressed={!landscape} className={!landscape ? "is-on" : ""}
          onClick={() => { if (landscape) run(setSize({ width: map.sizeMm.height, height: map.sizeMm.width })); }}>Portrait</button>
        <button type="button" aria-pressed={landscape} className={landscape ? "is-on" : ""}
          onClick={() => { if (!landscape) run(setSize({ width: map.sizeMm.height, height: map.sizeMm.width })); }}>Landscape</button>
      </div>
      <div className="field-pair">
        <NumberField label="Width (mm)" value={map.sizeMm.width} format={fmtMm}
          onCommit={(n) => setSize({ width: n, height: map.sizeMm.height })} />
        <NumberField label="Height (mm)" value={map.sizeMm.height} format={fmtMm}
          onCommit={(n) => setSize({ width: map.sizeMm.width, height: n })} />
      </div>
      <span className="help">{sizeLabel(map.sizeMm)}. The map's printed size; the artboard follows it unless you turn resizing off.</span>
    </>
  );
}

export function MapInspector({ map, style, sending = false, onPickCentre, onSend }: MapInspectorProps) {
  const markerId = useId();
  const [lon, lat] = map.centre;

  async function resetEdits(): Promise<void> {
    const answer = await confirm({
      title: "Reset hand edits?",
      body: `Put every object on '${map.name}' back to the app's version? Your colour, shape and position changes on this map are lost.`,
      buttons: ["Cancel", { label: "Reset", kind: "primary" }],
    });
    if (answer === "Reset") onSend({ mapIds: [map.id], reset: true });
  }

  async function deleteMap(): Promise<void> {
    const answer = await confirm({
      title: "Delete map?",
      body: `Delete '${map.name}' from this project? Anything already drawn in Affinity stays where it is.`,
      buttons: ["Cancel", { label: "Delete", kind: "danger" }],
    });
    if (answer !== "Delete") return;
    try {
      await api.deleteMap(map.id);
    } catch (e) {
      toast(message(e), "error");
    }
    void getActions().refreshProject().catch(() => undefined);
  }

  return (
    <>
      <Section chip="Map">
        <TextField label="Name" value={map.name} onCommit={(name) => patchMap(map.id, { name })} />
        <div className="field-pair">
          <NumberField label="Latitude" value={lat} format={fmtDeg} onCommit={(n) => patchMap(map.id, { centre: [lon, n] })} />
          <NumberField label="Longitude" value={lon} format={fmtDeg} onCommit={(n) => patchMap(map.id, { centre: [n, lat] })} />
        </div>
        <button type="button" className="btn" onClick={onPickCentre}><PinIcon size={15} />Pick on map</button>
        <ScaleControl map={map} />
        <NumberField label="Rotation" value={map.rotationDeg} format={fmtDeg} help={upLabel(map.rotationDeg)}
          onCommit={(n) => patchMap(map.id, { rotationDeg: n })} />
      </Section>
      <Section chip="Size">
        <SizeControls map={map} />
      </Section>
      <Section chip="Document">
        <TargetPicker map={map} />
      </Section>
      <Section chip="Marker">
        <div className="field">
          <label className="check" htmlFor={markerId}>
            <input id={markerId} type="checkbox" checked={map.marker}
              onChange={(e) => { patchMap(map.id, { marker: e.target.checked }).catch((err) => toast(message(err), "error")); }} />
            <span>Show the marker</span>
          </label>
          <span className="help">Puts the '{style.marker.label}' marker at the centre of the map.</span>
        </div>
      </Section>
      <Section chip="Actions">
        <button type="button" className="btn" disabled={sending} title={sending ? "Wait for the send to finish." : undefined}
          onClick={() => { void resetEdits(); }}>Reset hand edits…</button>
        <span className="help">Puts back anything you changed by hand in Affinity on this map.</span>
        <button type="button" className="btn btn-danger" onClick={() => { void deleteMap(); }}>Delete map…</button>
      </Section>
    </>
  );
}
