export type Position = [number, number];
export type Geometry =
  | { type: "Point"; coordinates: Position }
  | { type: "MultiPoint"; coordinates: Position[] }
  | { type: "LineString"; coordinates: Position[] }
  | { type: "MultiLineString"; coordinates: Position[][] }
  | { type: "Polygon"; coordinates: Position[][] }
  | { type: "MultiPolygon"; coordinates: Position[][][] };
export type GeometryKind = "point" | "line" | "polygon";
export interface GeoFeature { fid: string; name: string; geometry: Geometry; attrs: Record<string, string | number | boolean | null>; }
export interface ImportReport { read: number; skipped: number; reasons: string[]; }
export interface Dataset {
  name: string;                 // layer name, e.g. "Rivers"
  sourcePath: string;
  sourceFormat: "geojson" | "osm" | "shapefile" | "kml" | "gpx" | "csv";
  crs: CrsInfo;
  kind: GeometryKind;           // dominant kind; mixed input is split by readDataset into several datasets
  features: GeoFeature[];
  report: ImportReport;
}
export interface CrsInfo { id: string; proj4: string; label: string; }   // id e.g. "EPSG:27700" or "WKT:<hash>"
export type Bbox = [number, number, number, number];                     // minX, minY, maxX, maxY
export interface ProjectedLayer { name: string; kind: GeometryKind; features: GeoFeature[]; bbox: Bbox; }  // coords in projected units
export interface PageRect { x: number; y: number; width: number; height: number; }
export interface FrameTransform { scale: number; tx: number; ty: number; }  // page = (x*scale+tx, -y*scale+ty)
export interface MapFrame { id: string; name: string; projectionId: string; projectionParams?: Record<string, number>; rect: PageRect; transform?: FrameTransform; worldBbox?: Bbox; }  // transform/worldBbox are set by the first layer added
export interface JobFeature { fid: string; name: string; paths: number[][]; closed: boolean; }   // flat [x0,y0,x1,y1,…] in page px
export interface LayerJob { layerId: string; name: string; kind: GeometryKind; style: LayerStyle; features: JobFeature[]; skipped?: number; }  // skipped: features with no drawable path
export interface LayerStyle { fill: string | null; stroke: string | null; strokePt: number; pointRadiusPt: number; }  // hex colours
