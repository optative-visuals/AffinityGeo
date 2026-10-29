// Which Affinity document and artboard a map draws into. The lists come from /api/targets (polled by the store).
import { useEffect, useId, useState } from "react";
import type { MapSpec } from "@affinitygeo/geo-core";
import { ApiFail, api } from "../api.js";
import { toast } from "../shell/Toast.js";
import { useApp } from "../store.js";
import { artboardOf, patchMap, refreshAfterChange } from "./status.js";

const NEW = "new";
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface TargetPickerProps {
  map: MapSpec;
  /** Leaves out the resize checkbox (the Gallery card's quick re-target). */
  compact?: boolean;
}

export function TargetPicker({ map, compact = false }: TargetPickerProps) {
  const { project, targets, connection } = useApp();
  const docField = useId();
  const boardField = useId();
  const resizeField = useId();
  const [docId, setDocId] = useState(map.target?.docId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Follow the map when its target changes elsewhere.
  useEffect(() => { setDocId(map.target?.docId ?? ""); }, [map.id, map.target?.docId]);

  const projectId = project?.id ?? "";
  const doc = targets.find((d) => d.docId === docId);
  const current = artboardOf(doc, projectId, map.id);
  const targetOpen = !!map.target && targets.some((d) => d.docId === map.target!.docId);
  const otherName = (mapId: string) => project?.maps.find((m) => m.id === mapId && m.id !== map.id)?.name;

  async function run(fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    try {
      await fn();
      setError(null);
      return true;
    } catch (e) {
      // 400: a bad value; 502: Affinity's plain refusal ("That artboard already holds 'Library'.").
      if (e instanceof ApiFail && (e.status === 400 || e.status === 502 || e.status === 409)) setError(e.message);
      else toast(message(e), "error");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function chooseDocument(id: string): Promise<void> {
    const d = targets.find((x) => x.docId === id);
    if (!d || id === map.target?.docId) { setDocId(id); return; }
    setDocId(id);
    const ok = await run(() => patchMap(map.id, { target: { docId: d.docId, docTitle: d.title } }));
    if (!ok) setDocId(map.target?.docId ?? "");
    else refreshAfterChange(true);
  }

  async function chooseArtboard(value: string): Promise<void> {
    if (!doc || value === NEW) return;
    const artboardIndex = Number(value);
    const board = doc.artboards[artboardIndex];
    if (!board || artboardIndex === current) return;
    await run(async () => {
      await api.linkArtboard(map.id, { docId: doc.docId, artboardIndex, artboardName: board.name });
      refreshAfterChange(true);
    });
  }

  return (
    <div className="target-picker">
      <div className="field">
        <label className="field-label" htmlFor={docField}>Document</label>
        <select id={docField} value={docId} disabled={busy || !targets.length} onChange={(e) => { void chooseDocument(e.target.value); }}>
          {!docId && <option value="">Choose a document…</option>}
          {map.target && !targetOpen && <option value={map.target.docId}>{map.target.docTitle} (not open)</option>}
          {targets.map((d) => <option key={d.docId} value={d.docId}>{d.title}</option>)}
        </select>
        {!targets.length && (
          <span className="help">
            {connection.connected ? "Open a document in Affinity to draw this map into it."
              : "Connect Affinity (run Geo – Connect) to choose a document."}
          </span>
        )}
      </div>
      {doc && (
        <div className="field">
          <label className="field-label" htmlFor={boardField}>Artboard</label>
          <select id={boardField} value={current >= 0 ? String(current) : NEW} disabled={busy}
            onChange={(e) => { void chooseArtboard(e.target.value); }}>
            <option value={NEW} disabled={current >= 0}>New artboard</option>
            {doc.artboards.map((a, i) => {
              const holder = a.mapIds.map((m) => (m.projectId === projectId ? otherName(m.mapId) : undefined)).find(Boolean);
              return <option key={i} value={String(i)}>{holder ? `${a.name} (has ${holder})` : a.name}</option>;
            })}
          </select>
          <span className="help">
            {current >= 0 ? "Sends update this artboard." : "The first send adds an artboard at the map's size."}
          </span>
        </div>
      )}
      {error && <span className="help field-error" role="alert">{error}</span>}
      {!compact && (
        <div className="field">
          <label className="check" htmlFor={resizeField}>
            <input id={resizeField} type="checkbox" checked={map.resizeArtboard === true} disabled={busy}
              onChange={(e) => { void run(() => patchMap(map.id, { resizeArtboard: e.target.checked })); }} />
            <span>Resize the artboard to fit the map</span>
          </label>
          <span className="help">Off: the artboard keeps its size and the map sits centred on it. You can move it; later sends follow it.</span>
        </div>
      )}
    </div>
  );
}
