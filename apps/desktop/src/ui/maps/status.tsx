// Shared bits of the Maps screen: status badges, the target line, and map changes that refresh the project.
import type { MapSpec } from "@affinitygeo/geo-core";
import { api, type MapStatus, type TargetDocument } from "../api.js";
import { getActions } from "../store.js";

const TONES: Record<MapStatus, "grey" | "green" | "amber" | "red"> = {
  "Not sent": "grey",
  "Up to date": "green",
  "Changed since sent": "amber",
  "Target not open": "red",
};

/** The badge for a map: a map with no document yet is always "Not sent". */
export function badgeFor(map: Pick<MapSpec, "target">, status: MapStatus | undefined): MapStatus {
  if (!map.target) return "Not sent";
  return status ?? "Not sent";
}

export function StatusBadge({ status }: { status: MapStatus }) {
  return <span className={`badge badge-${TONES[status]}`}>{status}</span>;
}

/** The open artboard holding this map (found by its geo:map tag), if any. */
export function artboardOf(doc: TargetDocument | undefined, projectId: string, mapId: string): number {
  if (!doc) return -1;
  return doc.artboards.findIndex((a) => a.mapIds.some((m) => m.projectId === projectId && m.mapId === mapId));
}

/** "Campus maps · Lake", just the document title when no artboard is known, or "No document chosen". */
export function targetLine(map: Pick<MapSpec, "id" | "target">, targets: TargetDocument[], projectId: string): string {
  if (!map.target) return "No document chosen";
  const t = map.target;
  const doc = targets.find((d) => (t.docId ? d.docId === t.docId : d.title === t.docTitle));
  const i = artboardOf(doc, projectId, map.id);
  return i >= 0 ? `${t.docTitle} · ${doc!.artboards[i]!.name}` : t.docTitle;
}

const quiet = () => undefined;

/** Re-reads the project (and the badges when Affinity is there) after a change. */
export function refreshAfterChange(statuses = false): void {
  const a = getActions();
  void a.refreshProject().catch(quiet);
  if (statuses) void a.refreshStatuses().catch(quiet);
}

/** PATCHes one map, then re-reads the project either way. Rejects with the server's error. */
export async function patchMap(id: string, patch: Partial<MapSpec>): Promise<MapSpec> {
  try {
    return await api.patchMap(id, patch);
  } finally {
    refreshAfterChange();
  }
}
