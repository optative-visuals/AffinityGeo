// The street basemap: MapLibre on OpenFreeMap tiles, with overlays drawn above it in screen pixels.
// Offline (or when the style fails before the first load) it falls back to a plain canvas and a Web
// Mercator fit of the same bbox, so project/unproject, and therefore the overlays, keep working.
// A failed tile after the load is ignored; back online, the map is made again.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AttributionControl, Map as MapLibreMap, NavigationControl } from "maplibre-gl";
import type { Bbox } from "@affinitygeo/geo-core";

const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
const DEFAULT_PADDING = 24;

export interface BasemapApi {
  project(lonLat: [number, number]): [number, number];
  unproject(px: [number, number]): [number, number];
  /** Bumps on every move, so overlays re-render. */
  version: number;
}

export interface BasemapProps {
  /** The view to show: fitted once on mount and whenever fitKey changes. */
  fit: { bbox: Bbox; paddingPx?: number };
  fitKey: string;
  children?: (api: BasemapApi) => ReactNode;
}

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const unmercY = (y: number) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * (180 / Math.PI);

/** A Web Mercator fit of bbox into a w x h view, centred, with padding on every side. */
function fallbackProjection(bbox: Bbox, padding: number, w: number, h: number): Pick<BasemapApi, "project" | "unproject"> {
  const [west, south, east, north] = bbox;
  const dx = Math.max(east - west, 1e-9), dy = Math.max(mercY(north) - mercY(south), 1e-9);
  const k = Math.min(Math.max(w - 2 * padding, 1) / ((dx * Math.PI) / 180), Math.max(h - 2 * padding, 1) / dy);
  const cx = ((west + east) / 2 * Math.PI) / 180, cy = (mercY(north) + mercY(south)) / 2;
  return {
    project: ([lon, lat]) => [w / 2 + ((lon * Math.PI) / 180 - cx) * k, h / 2 - (mercY(lat) - cy) * k],
    unproject: ([x, y]) => [(((x - w / 2) / k + cx) * 180) / Math.PI, unmercY((h / 2 - y) / k + cy)],
  };
}

export function Basemap({ fit, fitKey, children }: BasemapProps) {
  const host = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const [offline, setOffline] = useState(() => typeof navigator !== "undefined" && navigator.onLine === false);
  const [version, setVersion] = useState(0);
  const [size, setSize] = useState({ w: 1, h: 1 });

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize((s) => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = host.current;
    if (!el || offline) return;
    const m = new MapLibreMap({
      container: el, style: STYLE_URL, dragRotate: false, pitchWithRotate: false, attributionControl: false,
    });
    m.dragRotate.disable();
    m.touchZoomRotate.disableRotation();
    m.addControl(new AttributionControl({ compact: true }), "bottom-right");
    m.addControl(new NavigationControl({ showCompass: false, visualizePitch: false }), "top-right");
    m.on("move", () => setVersion((v) => v + 1));
    // Before the first load an error is the style, sprite or glyphs: no map to show. After it, a
    // failed tile only leaves a gap, unless the browser has gone offline.
    let loaded = false;
    m.on("load", () => { loaded = true; });
    m.on("error", () => { if (!loaded || navigator.onLine === false) setOffline(true); });
    setMap(m);
    const { bbox, paddingPx } = fitRef.current;
    m.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: paddingPx ?? DEFAULT_PADDING, animate: false });
    return () => { setMap(null); m.remove(); };
  }, [offline]);

  useEffect(() => {
    const goOffline = () => setOffline(true);
    const goOnline = () => setOffline(false);
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => { window.removeEventListener("offline", goOffline); window.removeEventListener("online", goOnline); };
  }, []);

  const bboxKey = fit.bbox.join(",");
  const paddingPx = fit.paddingPx ?? DEFAULT_PADDING;
  const firstFit = useRef(true);
  useEffect(() => {
    // The map's creation effect already fitted the first view.
    if (firstFit.current) { firstFit.current = false; return; }
    const [w, s, e, n] = fitRef.current.bbox;
    map?.fitBounds([[w, s], [e, n]], { padding: paddingPx, animate: false });
    setVersion((v) => v + 1);
    // fitKey is the trigger; the bbox is read from the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  const api = useMemo<BasemapApi>(() => {
    if (map && !offline) {
      return {
        project: (p) => { const q = map.project(p); return [q.x, q.y]; },
        unproject: (p) => { const q = map.unproject(p); return [q.lng, q.lat]; },
        version,
      };
    }
    const [w, s, e, n] = bboxKey.split(",").map(Number) as Bbox;
    return { ...fallbackProjection([w, s, e, n], paddingPx, size.w, size.h), version };
  }, [map, offline, version, bboxKey, paddingPx, size.w, size.h]);

  return (
    <div className={`basemap basemap--dim${offline ? " basemap--offline" : ""}`}>
      <div ref={host} className="basemap-map" />
      {offline && <div className="basemap-note" role="status">Street map unavailable offline</div>}
      <div className="basemap-overlay">{children?.(api)}</div>
    </div>
  );
}
