// The numbered list of maps, with "+ Add map". The numbers match the pins on the Map view.
import { useApp } from "../store.js";
import { scaleLabel } from "./sizes.js";
import { StatusBadge, badgeFor } from "./status.js";

export interface MapListProps {
  adding: boolean;
  onAdd(): void;
  /** Selects a map (Shift/Ctrl adds to or removes from the selection). */
  onSelect(id: string, additive: boolean): void;
}

export function MapList({ adding, onAdd, onSelect }: MapListProps) {
  const { project, statuses, selectedMapIds } = useApp();
  const maps = project?.maps ?? [];
  return (
    <div className="map-list-panel">
      <div className="map-list-head">
        <span className="chip">Maps</span>
        <button type="button" className={`btn btn-small${adding ? " is-on" : ""}`} aria-pressed={adding} onClick={onAdd}>+ Add map</button>
      </div>
      {!maps.length && <p className="help map-list-empty">No maps yet. Choose + Add map, then click the map where it goes.</p>}
      <ol className="map-list" aria-label="Maps">
        {maps.map((m, i) => {
          const selected = selectedMapIds.includes(m.id);
          return (
            <li key={m.id}>
              <button type="button" className={`map-list-item${selected ? " is-selected" : ""}`} aria-pressed={selected}
                onClick={(e) => onSelect(m.id, e.shiftKey || e.ctrlKey || e.metaKey)}>
                <span className="map-number">{i + 1}</span>
                <span className="map-list-text">
                  <span className="map-list-name">{m.name}</span>
                  <span className="muted">{scaleLabel(m.scale)}</span>
                </span>
                <StatusBadge status={badgeFor(m, statuses[m.id])} />
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
