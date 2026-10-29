// AffinityGeo – draw-map.js (GPL-3.0-or-later)
// Lists open documents and artboards, draws or updates one map on its artboard
// without overwriting hand edits, and selects map objects.
// Plain CommonJS, ES2020, no build step. SDK modules are required lazily (sdk())
// so the pure helpers at the top can be tested in Node. send-plan.js and plan.js
// are passed in by the caller (sibling files can't be required by relative path).
//
// Document model (all tags are fixed keys: the SDK can't list keys):
//   artboard node      geo:map      {"projectId","mapId"}           name = map name
//   └ "Map — <name>"   geo:mapframe {"projectId","mapId","rect"}    rect = frame rect at the last send (spread px)
//     ├ "Frame"        grey outline (found by name, untagged): always the first child
//     ├ "Background"   geo:role "background": one unstroked rectangle filling the frame in the
//     │                style's paper colour (geo:fid "background:frame"), an ordinary map object
//     ├ <role label>   geo:role <roleId>, in style.order (bottom → top)
//     │  └ objects     geo:fid "<role>:<fid>", geo:sent = Props as last sent
//     └ "You are here" geo:role "marker": ring + dot circles (geo:fid marker:ring / marker:dot) and the label (marker:label)
'use strict';

const OUTLINE_BACK = "The map's frame outline was missing, so AffinityGeo put it back.";
const NO_MAP = "That map isn't in any open document. Send it to Affinity first.";
const MARKER_ROLE = 'marker';
const MARKER_NAME = 'You are here';
const BACKGROUND_ROLE = 'background';
const BACKGROUND_NAME = 'Background';
const RING_PT = 9;      // ring radius (pt)
const DOT_PT = 6;       // dot radius (pt)
const LABEL_GAP_MM = 1.5;

function notOpenMessage(title, mapName) {
  return "Open '" + title + "' in Affinity to update " + mapName;
}
function noTargetMessage(mapName) {
  return 'Choose a document for ' + mapName + ' in AffinityGeo first.';
}

// ---------- pure helpers (Node-tested) ----------

function round2(v) { const r = Math.round(v * 100) / 100; return r === 0 ? 0 : r; }
function round1(v) { const r = Math.round(v * 10) / 10; return r === 0 ? 0 : r; }
function hex2(n) { return (n < 16 ? '0' : '') + Math.max(0, Math.min(255, Math.round(n))).toString(16); }
function lower(c) { return c == null ? null : String(c).toLowerCase(); }
function parseJson(s) { try { return s == null ? null : JSON.parse(s); } catch (e) { return null; } }

/** Colour.rgba8 → "#rrggbb"; fully transparent → null (reads as "no colour"). */
function colourHex(c) {
  if (!c || c.alpha === 0) return null;
  return '#' + hex2(c.r) + hex2(c.g) + hex2(c.b);
}

function sameMap(tagValue, projectId, mapId) {
  const t = parseJson(tagValue);
  return !!t && t.projectId === projectId && t.mapId === mapId;
}

/** "paths:way/1" → { role: "paths", fid: "way/1" }. Role ids never contain a colon. */
function splitId(id) {
  const s = String(id == null ? '' : id);
  const i = s.indexOf(':');
  return i <= 0 ? null : { role: s.slice(0, i), fid: s.slice(i + 1) };
}

function nextArtboardX(boxes) {
  let right = null;
  for (const b of boxes || []) {
    const r = b.x + b.width;
    if (right === null || r > right) right = r;
  }
  return right === null ? 0 : right + 100;
}

/** The map frame's rect on an artboard: centred (equal sizes → the artboard's own rect). */
function placeFrame(ab, wPx, hPx) {
  return { x: round2(ab.x + (ab.width - wPx) / 2), y: round2(ab.y + (ab.height - hPx) / 2), width: wPx, height: hPx };
}

/**
 * The frame's new rects when the map size changed, or null when it didn't. B = the outline's
 * current box, k = the designer's scale of it (plan.frameBoxScale). With a resized artboard the
 * frame keeps its top-left corner (the artboard grew from its top-left too); otherwise it grows
 * or shrinks about its current centre, so a frame the designer moved stays where they put it.
 * Returns { R, B }: R is the unscaled layout rect (width = map mm x ppm), B the outline box.
 */
function resizedFrame(B, k, wPx, hPx, fromTopLeft) {
  if (Math.abs(B.width / k.sx - wPx) <= 0.5 && Math.abs(B.height / k.sy - hPx) <= 0.5) return null;
  const bw = wPx * k.sx, bh = hPx * k.sy;
  const x = fromTopLeft ? B.x : B.x + (B.width - bw) / 2;
  const y = fromTopLeft ? B.y : B.y + (B.height - bh) / 2;
  return { R: { x: x, y: y, width: wPx, height: hPx }, B: { x: x, y: y, width: bw, height: bh } };
}

/**
 * Normalises a MapJob so every sent prop is one Affinity can read back the same way:
 * lines have no fill; a stroke with no colour or no width is "no stroke" (null, 0 pt);
 * colours are lowercase; undrawable paths/features are dropped (plan.drawablePaths).
 * Layers are sorted by style.order (bottom → top) and the marker's ring and dot are
 * added on top as two "marker" point layers. The job's background (the paper) becomes one
 * more polygon layer put first, below them all (its order is below every other, so container
 * stacking keeps it lowest too): a single closed
 * rectangle over the whole frame, (0,0)-(width,height) mm, filled, with no stroke.
 */
function normaliseJob(job, plan) {
  let skipped = 0;
  const layers = [];
  for (const layer of (job && job.layers) || []) {
    const s = Object.assign({}, layer.style || {});
    s.fill = layer.kind === 'line' ? null : lower(s.fill);
    s.stroke = lower(s.stroke);
    if (!s.stroke || !(s.strokePt > 0)) { s.stroke = null; s.strokePt = 0; }
    s.visible = s.visible !== false;
    const features = [];
    for (const f of layer.features || []) {
      const paths = plan.drawablePaths(f, layer.kind);
      if (!paths.length) { skipped++; continue; }
      features.push(Object.assign({}, f, { paths: paths }));
    }
    layers.push(Object.assign({}, layer, { style: s, features: features }));
  }
  layers.sort(function (a, b) { return (a.style.order || 0) - (b.style.order || 0); });
  // The background goes first explicitly (not by its order), so no layer can ever sort below it.
  if (job && job.background && job.sizeMm) {
    const w = job.sizeMm.width, h = job.sizeMm.height;
    const lowest = layers.length ? Math.min(-1, (layers[0].style.order || 0) - 1) : -1;
    layers.unshift({ role: BACKGROUND_ROLE, name: BACKGROUND_NAME, kind: 'polygon',
      style: { fill: lower(job.background.fill), stroke: null, strokePt: 0, visible: true, order: lowest, pointRadiusPt: 0 },
      features: [{ fid: 'frame', name: BACKGROUND_NAME, paths: [[0, 0, w, 0, w, h, 0, h]], closed: true }] });
  }
  if (job && job.marker) {
    const m = job.marker;
    const ms = m.style || {};
    const order = layers.length ? layers[layers.length - 1].style.order + 1 : 0;
    const pointStyle = function (fill, radiusPt) {
      return { fill: lower(fill), stroke: null, strokePt: 0, visible: true, order: order, pointRadiusPt: radiusPt };
    };
    layers.push({ role: MARKER_ROLE, name: MARKER_NAME, kind: 'point', style: pointStyle(ms.ring, RING_PT),
      features: [{ fid: 'ring', name: 'Ring', paths: [[m.x, m.y]], closed: false }] });
    layers.push({ role: MARKER_ROLE, name: MARKER_NAME, kind: 'point', style: pointStyle(ms.dot, DOT_PT),
      features: [{ fid: 'dot', name: 'Dot', paths: [[m.x, m.y]], closed: false }] });
  }
  return { job: Object.assign({}, job, { layers: layers }), skipped: skipped };
}

/**
 * Frame-local mm ↔ spread px. R = the frame rect the map was laid out for (spread px,
 * R.width = map width in mm × ppm); B = where the "Frame" outline is now (moved or scaled
 * by the designer). Drawing goes mm → R px → B px with plan.mapToFrameBox;
 * reading back is the exact inverse with the same scale rule (plan.frameBoxScale).
 */
function frameMapping(R, B, ppm, plan) {
  const k = plan.frameBoxScale(R, B);
  return {
    box: B,
    scale: k,
    toPage: function (paths) {
      const px = (paths || []).map(function (p) {
        const out = new Array(p.length);
        for (let i = 0; i + 1 < p.length; i += 2) { out[i] = R.x + p[i] * ppm; out[i + 1] = R.y + p[i + 1] * ppm; }
        return out;
      });
      // mapToFrameBox returns paths untouched when B equals R: round them the same way regardless.
      return plan.mapToFrameBox(px, R, B).map(function (p) { return p.map(round2); });
    },
    toMm: function (x, y) {
      return [(x - B.x) / k.sx / ppm, (y - B.y) / k.sy / ppm];
    },
  };
}

/**
 * The geometry signature of what Affinity holds, by the SAME rule as send-plan's
 * geomSignature (it is called to do the work):
 *   points: the centre of the object's spread bounding box → "p:cx,cy";
 *   lines/polygons: every curve's on-curve nodes (spread px) → frame mm paths → "n:x,y,w,h".
 * read: { kind, curves: [{ closed, nodes: [[x, y], …] }], bbox: {x,y,width,height}|null }
 */
function signatureFromRead(read, mapping, geomSignature) {
  if (read.kind === 'point') {
    const b = read.bbox;
    if (!b) return geomSignature([], 'point');
    const c = mapping.toMm(b.x + b.width / 2, b.y + b.height / 2);
    return geomSignature([[c[0], c[1]]], 'point');
  }
  const paths = [];
  for (const c of read.curves || []) {
    const p = [];
    for (const n of c.nodes) { const mm = mapping.toMm(n[0], n[1]); p.push(mm[0], mm[1]); }
    if (p.length) paths.push(p);
  }
  return geomSignature(paths, read.kind);
}

// ---------- SDK ----------

let S = null;
function sdk() {
  if (S) return S;
  const C = require('/commands.js');
  const dom = require('affinity:dom');
  S = {
    C: C,
    N: require('/nodes.js'),
    G: require('/geometry.js'),
    FillDescriptor: require('/fills.js').FillDescriptor,
    Colour: require('/colours.js').Colour,
    L: require('/linestyle.js'),
    BlendMode: require('affinity:common').BlendMode,
    Selection: require('/selections.js').Selection,
    SpatialAnchor: dom.SpatialAnchor,
    NodeMoveType: dom.NodeMoveType,
    StoryBuilder: require('/storybuilder.js').StoryBuilder,
    StoryDelta: require('/storydelta.js').StoryDelta,
    GlyphAttDoubleType: require('/glyphatts.js').GlyphAttDoubleType,
  };
  return S;
}

function solid(r, g, b) {
  const s = sdk();
  return s.FillDescriptor.createSolid(s.Colour.createRGBA8({ r: r, g: g, b: b, alpha: 255 }), s.BlendMode.Normal);
}

function parseHex(hex) {
  if (typeof hex !== 'string') return null;
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-fA-F]{6}/.test(h)) return null;
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

function fillFor(hex) {
  const c = parseHex(hex);
  return c ? solid(c.r, c.g, c.b) : sdk().FillDescriptor.createNone();
}

function opaque() { return solid(255, 255, 255); } // the transparency argument must be opaque white

function lineStyleDesc(px) {
  const L = sdk().L;
  return L.LineStyleDescriptor.create(L.LineStyle.createDefaultWithWeight(px));
}

function list(collection) {
  try { return collection ? [...collection] : []; } catch (e) { return []; }
}
function children(node) {
  try { return node && node.children ? [...node.children] : []; } catch (e) { return []; }
}

function tagOf(node, key) {
  try {
    if (!node || typeof node.getValueForKey !== 'function') return null;
    // getValueForKey throws INVALID_ARGS for a key the node doesn't have: ask hasKey first.
    if (typeof node.hasKey === 'function' && !node.hasKey(key)) return null;
    const v = node.getValueForKey(key);
    return v == null || v === '' ? null : String(v);
  } catch (e) { return null; }
}

function setTag(doc, node, key, value) {
  const s = sdk();
  return s.C.DocumentCommand.createSetTagValueForKey(s.Selection.create(doc, node), key, value);
}

function sel(doc, nodes) { return sdk().Selection.create(doc, nodes); }

function run(doc, cmds) {
  if (!cmds.length) return;
  const cb = sdk().C.CompoundCommandBuilder.create();
  for (const c of cmds) cb.addCommand(c);
  doc.executeCommand(cb.createCommand());
}

function boxOf(b) { return { x: b.x, y: b.y, width: b.width, height: b.height }; }

function rotationOf(node) {
  try {
    const d = node.baseToSpreadTransform.decompose();
    return typeof d.rotation === 'number' ? d.rotation : 0;
  } catch (e) { return 0; }
}

/** createSetCurves works in the node's base space: undo the node's (or its group's) transform first. */
function toNodeBase(node, pc) {
  const t = node.baseToSpreadTransform;
  const inv = typeof t.inverted === 'function' ? t.inverted() : t.inverted;
  if (inv) pc.transform(inv);
  return pc;
}

function circleCurve(x, y, r) {
  const G = sdk().G;
  return G.Curve.createEllipse(new G.Rectangle(x - r, y - r, 2 * r, 2 * r));
}

function rectCurve(r) {
  const G = sdk().G;
  const cb = G.CurveBuilder.create();
  cb.beginXY(r.x, r.y);
  cb.lineToXY(r.x + r.width, r.y);
  cb.lineToXY(r.x + r.width, r.y + r.height);
  cb.lineToXY(r.x, r.y + r.height);
  cb.close();
  const pc = new G.PolyCurve();
  pc.addCurve(cb.createCurve());
  return pc;
}

/** pagePaths are spread px. Points become circles of radiusPx. */
function polyCurveFor(pagePaths, kind, closed, radiusPx) {
  const G = sdk().G;
  const pc = new G.PolyCurve();
  for (const p of pagePaths) {
    if (kind === 'point') { pc.addCurve(circleCurve(p[0], p[1], radiusPx)); continue; }
    const cb = G.CurveBuilder.create();
    cb.beginXY(p[0], p[1]);
    for (let i = 2; i + 1 < p.length; i += 2) cb.lineToXY(p[i], p[i + 1]);
    if (closed) cb.close();
    pc.addCurve(cb.createCurve());
  }
  return pc;
}

// ---------- reading Props back ----------

function fillHexOf(descriptor) {
  try {
    const fill = descriptor.fill;
    const t = String(fill);
    if (/NoFill/.test(t)) return null;
    if (/SolidFill/.test(t)) return colourHex(fill.colour.rgba8);
    return 'other'; // gradient, bitmap…: a hand edit
  } catch (e) { return 'other'; }
}

/** Art text's colour lives in its story (the node itself reports NoFill). */
function readTextFill(node) {
  try { return fillHexOf(node.story.getGlyphAtts(0).brushFill); } catch (e) { return 'other'; }
}

/** Text compared as text: any line or paragraph break → "\n", no trailing whitespace. */
function normText(t) {
  return String(t).replace(/\r\n?|[\u2028\u2029]/g, '\n').replace(/\s+$/, '');
}

/** Art text's characters (live: ArtTextNode.text), normalised; undefined if unreadable. */
function readText(node) {
  try {
    const t = node.text;
    if (typeof t === 'string') return normText(t);
  } catch (e) { /* unreadable */ }
  return undefined;
}

/** A read that may fail: undefined means "unknown", never "changed". */
function tryRead(fn) {
  try { const v = fn(); return v === undefined || (typeof v === 'number' && !isFinite(v)) ? undefined : v; } catch (e) { return undefined; }
}

function fontName(font) {
  const ps = tryRead(function () { return font.postscriptName; });
  if (ps != null && String(ps) !== '') return String(ps);
  const fam = tryRead(function () { return font.familyName; });
  const traits = tryRead(function () { return font.traitsName; });
  return fam == null ? undefined : String(fam) + (traits == null ? '' : ' ' + String(traits));
}

function degrees(t) { return t.decompose().rotation * 180 / Math.PI; }

/**
 * What the "You are here" label looks like now, as far as it can be read: every field is
 * undefined when its read fails (unknown, so never counted as an edit).
 *   fill / last  colour of the first / last glyph; text (normalised); font (PostScript name);
 *   hPx          glyph height (px); pos / size  box top-left / size in frame-local mm (0.1 mm);
 *   rot          rotation relative to its parent (degrees, 0.1).
 */
function labelSignature(node, mapping) {
  const story = tryRead(function () { return node.story; });
  const g0 = story ? tryRead(function () { return story.getGlyphAtts(0); }) : undefined;
  const n = story ? tryRead(function () { return Number(story.length); }) : undefined;
  const sig = {};
  if (g0) {
    sig.fill = tryRead(function () { return fillHexOf(g0.brushFill); });
    sig.hPx = tryRead(function () { return round2(Number(g0.height)); });
    sig.font = tryRead(function () { return fontName(g0.font); });
  }
  if (story && n > 0) sig.last = tryRead(function () { return fillHexOf(story.getGlyphAtts(n - 1).brushFill); });
  sig.text = readText(node);
  const b = tryRead(function () { return boxOf(node.spreadBaseBox); });
  if (b) {
    const tl = mapping.toMm(b.x, b.y), br = mapping.toMm(b.x + b.width, b.y + b.height);
    if ([tl[0], tl[1], br[0], br[1]].every(isFinite)) {
      sig.pos = [round1(tl[0]), round1(tl[1])];
      sig.size = [round1(br[0] - tl[0]), round1(br[1] - tl[1])];
    }
  }
  sig.rot = tryRead(function () {
    let d = degrees(node.baseToSpreadTransform) - (node.parent ? degrees(node.parent.baseToSpreadTransform) : 0);
    while (d > 180) d -= 360;
    while (d <= -180) d += 360;
    return round1(d);
  });
  return sig;
}

/** Two [x, y] mm pairs within the geometry tolerance (0.15 mm, as send-plan's geomSame). */
function mmSame(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === 2 && b.length === 2 &&
    Math.abs(a[0] - b[0]) <= 0.15 + 1e-9 && Math.abs(a[1] - b[1]) <= 0.15 + 1e-9;
}

/**
 * Has the designer edited the "You are here" label since it was sent? Colour (first or last
 * glyph), text, font, size, box (moved, scaled, re-spaced) or rotation. Only fields both
 * recorded in geo:sent and readable now are compared: older records (e.g. { fill } only) and
 * failed reads are ignored, so a label never becomes "edited" for good by a read that fails.
 */
function labelEdited(node, sent, mapping) {
  const now = labelSignature(node, mapping);
  const known = function (k) { return sent[k] !== undefined && sent[k] !== null && now[k] !== undefined; };
  if (Object.prototype.hasOwnProperty.call(sent, 'fill') && now.fill !== undefined && now.fill !== sent.fill) return true;
  if (known('last') && now.last !== sent.last) return true;
  if (known('text') && now.text !== normText(sent.text)) return true;
  if (known('font') && now.font !== sent.font) return true;
  if (known('hPx') && Math.abs(now.hPx - sent.hPx) > 0.05) return true;
  if (known('pos') && !mmSame(now.pos, sent.pos)) return true;
  if (known('size') && !mmSame(now.size, sent.size)) return true;
  if (known('rot') && Math.abs(now.rot - sent.rot) > 0.5) return true;
  return false;
}

function readFill(node) {
  try { return fillHexOf(node.brushFillDescriptor); } catch (e) { return 'other'; }
}

function readStroke(node, dpi) {
  try {
    const weight = Number(node.lineWeight);
    if (node.isLineStyleVisible === false || !(weight > 0) || /none/i.test(String(node.lineType == null ? '' : node.lineType))) {
      return { stroke: null, widthPt: 0 };
    }
    const hex = fillHexOf(node.penFillDescriptor);
    if (hex === null) return { stroke: null, widthPt: 0 };
    return { stroke: hex, widthPt: round2(weight * 72 / dpi) };
  } catch (e) { return { stroke: 'other', widthPt: 0 }; }
}

/** Spread-space curves of a node: on-curve nodes per curve, plus the exact bounding box. */
function readCurves(node) {
  const out = { curves: [], bbox: null };
  let pc;
  try { pc = node.polyCurve.clone().transform(node.baseToSpreadTransform); } catch (e) { pc = null; }
  if (!pc) return out;
  try { const b = pc.boundingBox; if (b) out.bbox = boxOf(b); } catch (e) { /* none */ }
  for (let i = 0; i < pc.curveCount; i++) {
    const curve = pc.at(i);
    const nodes = [];
    let first = true;
    const bz = curve.beziers;
    for (const z of (bz && typeof bz.toArray === 'function' ? bz.toArray() : list(bz))) {
      if (first) { nodes.push([z.start.x, z.start.y]); first = false; }
      nodes.push([z.end.x, z.end.y]);
    }
    if (nodes.length) out.curves.push({ closed: !!curve.isClosed, nodes: nodes });
  }
  return out;
}

/** Props { fill, stroke, widthPt, visible, geom } of an object as Affinity holds it now. */
function readProps(node, kind, mapping, dpi, geomSignature) {
  const st = readStroke(node, dpi);
  const c = readCurves(node);
  let visible;
  try { visible = node.isVisible !== false; } catch (e) { visible = true; }
  return {
    fill: readFill(node),
    stroke: st.stroke,
    widthPt: st.widthPt,
    visible: visible,
    geom: signatureFromRead({ kind: kind, curves: c.curves, bbox: c.bbox }, mapping, geomSignature),
  };
}

// ---------- finding things ----------

function spreadsOf(doc) {
  const s = list(doc.spreads);
  return s.length ? s : [doc.currentSpread];
}

function artboardsOf(doc) {
  const out = [];
  for (const sp of spreadsOf(doc)) {
    try { for (const ab of sp.artboards) out.push(ab); } catch (e) { /* not an artboard spread */ }
  }
  if (!out.length) { try { for (const ab of doc.artboards) out.push(ab); } catch (e) { /* none */ } }
  return out;
}

function mapIdsOf(abNode) {
  const t = parseJson(tagOf(abNode, 'geo:map'));
  return t && t.projectId != null && t.mapId != null ? [{ projectId: t.projectId, mapId: t.mapId }] : [];
}

function docId(doc) {
  try { return String(doc.persistentUuid); } catch (e) { return ''; }
}
function docTitle(doc) {
  try { return String(doc.title); } catch (e) { return ''; }
}

function artboardName(ab, node) {
  try { return String((node && node.userDescription) || ab.description || ''); } catch (e) { return ''; }
}

/** listTargets(documents) → { documents: [{ docId, title, artboards: [{ name, mapIds, widthMm, heightMm }] }] } */
function listTargets(documents) {
  const out = [];
  for (const doc of documents || []) {
    const ppm = doc.dpi / 25.4;
    const artboards = [];
    for (const ab of artboardsOf(doc)) {
      let node;
      try { node = ab.node; } catch (e) { node = null; }
      const b = ab.spreadBaseBox;
      const name = artboardName(ab, node);
      artboards.push({ name: name, mapIds: node ? mapIdsOf(node) : [], widthMm: round1(b.width / ppm), heightMm: round1(b.height / ppm) });
    }
    out.push({ docId: docId(doc), title: docTitle(doc), artboards: artboards });
  }
  return { documents: out };
}

/** Every open artboard tagged with this map: [{ doc, ab, node }]. */
function findMapArtboards(documents, projectId, mapId) {
  const found = [];
  for (const doc of documents || []) {
    for (const ab of artboardsOf(doc)) {
      let node;
      try { node = ab.node; } catch (e) { continue; }
      if (sameMap(tagOf(node, 'geo:map'), projectId, mapId)) found.push({ doc: doc, ab: ab, node: node });
    }
  }
  return found;
}

/** Depth-limited search for a node whose tag satisfies test; never descends into map objects. */
function findTagged(nodes, key, test, depth) {
  for (const n of nodes) {
    if (test(tagOf(n, key))) return n;
  }
  if (depth <= 0) return null;
  for (const n of nodes) {
    if (tagOf(n, 'geo:fid') != null || tagOf(n, 'geo:role') != null) continue;
    const hit = findTagged(children(n), key, test, depth - 1);
    if (hit) return hit;
  }
  return null;
}

function findFrameGroup(doc, abNode, projectId, mapId) {
  const test = function (v) { return sameMap(v, projectId, mapId); };
  return findTagged(children(abNode), 'geo:mapframe', test, 2) ||
    findTagged(list(doc.layers), 'geo:mapframe', test, 4);
}

/** Every geo:mapframe group of this map in the document, wherever the designer put it. */
function allFrameGroups(doc, projectId, mapId) {
  const out = [];
  const walk = function (nodes, depth) {
    for (const n of nodes) {
      if (sameMap(tagOf(n, 'geo:mapframe'), projectId, mapId)) { out.push(n); continue; }
      if (depth <= 0 || tagOf(n, 'geo:fid') != null || tagOf(n, 'geo:role') != null) continue;
      walk(children(n), depth - 1);
    }
  };
  walk(list(doc.layers), 5);
  return out;
}

function findOutline(group) {
  for (const c of children(group)) {
    if (c && c.userDescription === 'Frame' && tagOf(c, 'geo:role') == null && tagOf(c, 'geo:fid') == null) return c;
  }
  return null;
}

/** All app objects under the frame group (in any container the designer moved them to). */
function collectObjects(group, out, depth) {
  for (const c of children(group)) {
    const id = tagOf(c, 'geo:fid');
    if (id != null) { out.push({ id: id, node: c }); continue; }
    if (depth > 0) collectObjects(c, out, depth - 1);
  }
  return out;
}

function pickDocument(documents, target) {
  if (!target) return null;
  // The document id survives save, quit and reopen: never fall back to a title (two documents
  // can both be "Untitled"). Only a target recorded without an id is looked up by title.
  if (target.docId) {
    for (const d of documents) if (docId(d) === String(target.docId)) return d;
    return null;
  }
  for (const d of documents) if (target.docTitle && docTitle(d) === String(target.docTitle)) return d;
  return null;
}

// ---------- creating ----------

function addContainer(doc, parent, name) {
  const s = sdk();
  const b = s.C.AddChildNodesCommandBuilder.create();
  b.setInsertionTarget(parent);
  const def = s.N.ContainerNodeDefinition.createDefault();
  def.setUserDescription(name);
  b.addContainerNode(def);
  const cmd = b.createCommand(false, s.C.NodeChildType.Main);
  doc.executeCommand(cmd);
  return cmd.newNodes[0];
}

function addOutline(doc, group, rect) {
  const s = sdk();
  const b = s.C.AddChildNodesCommandBuilder.create();
  b.setInsertionTarget(group);
  const def = s.N.PolyCurveNodeDefinition.create(rectCurve(rect), s.FillDescriptor.createNone(), solid(0x8c, 0x8c, 0x8c),
    lineStyleDesc(0.5 * doc.dpi / 72), opaque());
  def.setUserDescription('Frame');
  b.addPolyCurveNode(def);
  const cmd = b.createCommand(false, s.C.NodeChildType.Main);
  doc.executeCommand(cmd);
  const kids = children(group);
  const outline = cmd.newNodes[0] || kids[kids.length - 1];
  // The outline sits at the back of the frame group.
  if (kids.length > 1 && outline) {
    try {
      doc.executeCommand(s.C.DocumentCommand.createMoveNodes(sel(doc, outline), kids[0], s.NodeMoveType.Before, s.C.NodeChildType.Main));
    } catch (e) { /* stays on top: cosmetic only */ }
  }
  return outline;
}

function newArtboard(doc, job, ppm) {
  const s = sdk();
  const before = artboardsOf(doc);
  const x = nextArtboardX(before.map(function (a) { return boxOf(a.spreadBaseBox); }));
  doc.addRectangularArtboard(new s.G.Rectangle(x, 0, job.sizeMm.width * ppm, job.sizeMm.height * ppm), false, false, false);
  const after = artboardsOf(doc);
  let ab = null;
  for (const a of after) {
    let seen = false;
    for (const b of before) { try { if (a.isSameObject(b)) { seen = true; break; } } catch (e) { /* ignore */ } }
    if (!seen) { ab = a; break; }
  }
  if (!ab) ab = after[after.length - 1];
  if (!ab) throw new Error("Affinity didn't create the artboard for " + job.mapName + '.');
  const node = ab.node;
  run(doc, [
    setTag(doc, node, 'geo:map', JSON.stringify({ projectId: job.projectId, mapId: job.mapId })),
    s.C.DocumentCommand.createSetDescription(sel(doc, node), job.mapName),
  ]);
  return { ab: ab, node: node };
}

function labelDef(doc, text, x, y, hex, textPt) {
  const s = sdk();
  const sb = s.StoryBuilder.create();
  sb.setToArtisticTextDefaultStyle(doc.dpi, doc.rasterFormat);
  sb.applyGlyphDelta(s.StoryDelta.createGlyphDouble(s.GlyphAttDoubleType.Height, textPt * doc.dpi / 72));
  sb.applyGlyphDelta(s.StoryDelta.createBrushFill(fillFor(hex)));
  sb.addText(text);
  const def = s.N.ArtTextNodeDefinition.createFromStoryBuilder({ x: x, y: y }, sb);
  def.setUserDescription(text);
  return def;
}

// ---------- sendMap ----------

/**
 * sendMap(documents, { job, target, resizeArtboard, reset, sentIds }, { sendPlan, plan })
 *   → { created, updated, removed, keptEdited: [{fid, role, name, reason}], resized, warnings, objectIds, skipped, docId, docTitle }
 * The artboard tagged geo:map {projectId, mapId} is looked for in every open document; a
 * new one is only ever made in the target document. Never draws into another document.
 */
function sendMap(documents, payload, deps) {
  const s = sdk();
  const sp = deps.sendPlan;
  const plan = deps.plan;
  const raw = payload.job;
  const reset = !!payload.reset;
  const warnings = [];

  // 1. Where does the map live?
  // A target with a document id means that document only: a Save-As copy holding the same
  // tagged artboard is never drawn into. Only a target without an id is looked for everywhere.
  let found = findMapArtboards(documents, raw.projectId, raw.mapId);
  if (payload.target && payload.target.docId) {
    found = found.filter(function (f) { return docId(f.doc) === String(payload.target.docId); });
  }
  let doc = null, ab = null, abNode = null;
  if (found.length) {
    doc = found[0].doc; ab = found[0].ab; abNode = found[0].node;
  } else {
    if (!payload.target) throw new Error(noTargetMessage(raw.mapName));
    doc = pickDocument(documents, payload.target);
    if (!doc) throw new Error(notOpenMessage(payload.target.docTitle || 'the document', raw.mapName));
  }

  const dpi = doc.dpi;
  const ppm = dpi / 25.4;
  const wPx = raw.sizeMm.width * ppm;
  const hPx = raw.sizeMm.height * ppm;
  // A frame made in this send (new artboard or new group) is empty: whatever was sent before is
  // gone with the old one (deleted, or never saved), so everything is drawn again, no warnings.
  // (A new artboard alone doesn't make it fresh: the old group may have been moved elsewhere first.)
  let freshFrame = false;
  if (!ab) {
    const made = newArtboard(doc, raw, ppm);
    ab = made.ab; abNode = made.node;
  }

  // 2. Artboard size.
  let resized = false;
  let abBox = boxOf(ab.spreadBaseBox);
  const sizeDiffers = Math.abs(abBox.width - wPx) > 0.5 || Math.abs(abBox.height - hPx) > 0.5;
  if (sizeDiffers && payload.resizeArtboard === true) {
    doc.executeCommand(s.C.DocumentCommand.createSetArtboardSizeWithAnchor(ab, wPx, hPx, s.SpatialAnchor.TopLeft));
    resized = true;
    abBox = boxOf(ab.spreadBaseBox);
  }

  // 3. The map frame group and its outline.
  const frameTag = function (rect) {
    return JSON.stringify({ projectId: raw.projectId, mapId: raw.mapId, rect: { x: round2(rect.x), y: round2(rect.y), width: round2(rect.width), height: round2(rect.height) } });
  };
  let group = findFrameGroup(doc, abNode, raw.projectId, raw.mapId);
  let R;
  let outline;
  if (!group) {
    freshFrame = true;
    R = placeFrame(abBox, wPx, hPx);
    group = addContainer(doc, abNode, 'Map — ' + raw.mapName);
    run(doc, [setTag(doc, group, 'geo:mapframe', frameTag(R))]); // tagged straight away: never an orphan group
    outline = addOutline(doc, group, R);
  } else {
    const stored = parseJson(tagOf(group, 'geo:mapframe'));
    R = stored && stored.rect && stored.rect.width > 0 ? stored.rect : placeFrame(abBox, wPx, hPx);
    outline = findOutline(group);
    if (!outline) {
      outline = addOutline(doc, group, R);
      warnings.push(OUTLINE_BACK);
    }
  }
  let B;
  try { B = boxOf(outline.spreadBaseBox); } catch (e) { B = R; }
  for (const w of plan.frameBoxWarnings(R, B, rotationOf(outline))) warnings.push(w);
  const readMapping = frameMapping(R, B, ppm, plan); // how the objects already there were laid out

  // Two command lists:
  //  createTags: geo:fid + geo:sent of objects made in THIS send. They must land even if the
  //              send fails later, or the next send would find untagged orphans and draw them again.
  //  updateCmds: everything that changes what was already there (properties, geometry, their
  //              geo:sent refreshes, the outline and its rect tag, removals). They run in one compound
  //              with createTags; if that compound fails only createTags are retried, so geo:sent
  //              never records a value that wasn't applied.
  const createTags = [];
  const updateCmds = [];
  let drawR = R, drawB = B;
  const newSize = resizedFrame(B, readMapping.scale, wPx, hPx, payload.resizeArtboard === true);
  if (newSize) {
    drawR = newSize.R;
    drawB = newSize.B;
    updateCmds.push(s.C.DocumentCommand.createSetCurves(outline.curvesInterface, toNodeBase(outline, rectCurve(drawB))));
    updateCmds.push(setTag(doc, group, 'geo:mapframe', frameTag(drawR)));
  }
  const drawMapping = frameMapping(drawR, drawB, ppm, plan);

  // 4. Read what's there, plan the send.
  const norm = normaliseJob(raw, plan);
  const job = norm.job;
  const kindOf = {}, layerOf = {};
  for (const l of job.layers) { kindOf[l.role] = l.kind; for (const f of l.features) layerOf[l.role + ':' + f.fid] = l; }
  const existing = [];
  let label = null;
  for (const o of collectObjects(group, [], 3)) {
    if (o.id === 'marker:label') { if (!label) label = o.node; continue; }
    const id = splitId(o.id);
    if (!id) continue;
    const sent = parseJson(tagOf(o.node, 'geo:sent'));
    const kind = kindOf[id.role] || (sent && typeof sent.geom === 'string' && sent.geom.indexOf('p:') === 0 ? 'point' : 'line');
    existing.push({ id: o.id, role: id.role, fid: id.fid, nodeId: o.node, sent: sent,
      current: readProps(o.node, kind, readMapping, dpi, sp.geomSignature) });
  }
  const sentIds = freshFrame ? [] : (payload.sentIds || []);
  const p = sp.planSend(existing, job, { reset: reset, sentIds: sentIds });
  for (const w of p.warnings) warnings.push(w);

  const marker = raw.marker;
  const ms = (marker && marker.style) || {};
  const wantLabel = marker ? { fill: lower(ms.text), textPt: ms.textPt || 10, text: String(ms.label || MARKER_NAME),
    at: [round2(marker.x), round2(marker.y)] } : null;
  const sentLabel = label ? (parseJson(tagOf(label, 'geo:sent')) || {}) : null;
  let labelAction = marker && !label ? 'create' : 'none';
  let labelKept = false;
  let labelDeleted = false;
  // A label the designer deleted stays deleted (like any map object), unless reset.
  if (labelAction === 'create' && !reset && sentIds.indexOf('marker:label') >= 0) {
    labelAction = 'none';
    labelDeleted = true;
    warnings.push("The 'You are here' label you deleted was not recreated");
  }
  if (label) {
    const edited = labelEdited(label, sentLabel, readMapping);
    if (!marker) {
      if (reset || !edited) labelAction = 'remove'; else labelKept = true;
    } else if (edited && !reset) {
      labelKept = true;
    } else if (edited || sentLabel.textPt !== wantLabel.textPt || sentLabel.text == null || normText(sentLabel.text) !== normText(wantLabel.text) || !mmSame(sentLabel.at, wantLabel.at)) {
      labelAction = 'replace';
    } else if (sentLabel.fill !== wantLabel.fill) {
      labelAction = 'recolour';
    }
  }
  let labelUpdated = false;
  // A new label goes in with the main compound (tags, and for a replacement the move and the
  // old label's removal). If that compound fails, the new label is deleted again instead of
  // tagged: its geo:sent would describe a frame change that did not happen.
  let newLabel = null;
  const labelCmds = [];
  const dropNewLabel = function () {
    if (newLabel) { try { doc.executeCommand(s.C.DocumentCommand.createDeleteSelection(sel(doc, newLabel))); } catch (e) { /* ignore */ } }
  };

  const created = [];
  const removed = p.remove.slice();
  try {
  // 5. Containers: one per role with something to create, in style.order; the marker group on top.
  const containers = {};
  for (const c of children(group)) {
    const r = tagOf(c, 'geo:role');
    if (r != null && !containers[r]) containers[r] = c;
  }
  const orderOf = function (role) {
    if (role === MARKER_ROLE) return Infinity;
    for (const l of job.layers) if (l.role === role) return l.style.order;
    return null;
  };
  const needed = [];
  for (const c of p.create) if (!containers[c.role] && needed.indexOf(c.role) < 0) needed.push(c.role);
  if (labelAction === 'create' && !containers[MARKER_ROLE] && needed.indexOf(MARKER_ROLE) < 0) needed.push(MARKER_ROLE);
  needed.sort(function (a, b) { return orderOf(a) - orderOf(b); });
  if (needed.length) {
    const b = s.C.AddChildNodesCommandBuilder.create();
    b.setInsertionTarget(group);
    const names = [];
    for (const role of needed) {
      const l = job.layers.find(function (x) { return x.role === role; });
      const name = role === MARKER_ROLE ? MARKER_NAME : (l ? l.name : role);
      const def = s.N.ContainerNodeDefinition.createDefault();
      def.setUserDescription(name);
      b.addContainerNode(def);
      names.push(name);
    }
    const before = children(group).length;
    const cmd = b.createCommand(false, s.C.NodeChildType.Main);
    doc.executeCommand(cmd);
    let fromCmd = [];
    try { fromCmd = cmd.newNodes ? [...cmd.newNodes].reverse() : []; } catch (e) { fromCmd = []; }
    const picked = plan.pickCreatedNodes(children(group).slice(before), fromCmd, names, function (n) { return n.userDescription; });
    const cmds = [];
    for (let i = 0; i < picked.nodes.length; i++) {
      containers[needed[i]] = picked.nodes[i];
      cmds.push(setTag(doc, picked.nodes[i], 'geo:role', needed[i]));
    }
    // Stack each new container just above the highest container below it in style.order.
    for (const role of needed) {
      if (role === MARKER_ROLE) continue; // added last, so already on top
      const o = orderOf(role);
      let below = null, belowOrder = -Infinity;
      for (const r of Object.keys(containers)) {
        if (r === role) continue;
        const ro = orderOf(r);
        if (ro != null && ro < o && ro > belowOrder) { below = containers[r]; belowOrder = ro; }
      }
      const anchor = below || outline;
      if (anchor) cmds.push(s.C.DocumentCommand.createMoveNodes(sel(doc, containers[role]), anchor, s.NodeMoveType.After, s.C.NodeChildType.Main));
    }
    run(doc, cmds);
  }

  // 6. New objects: one AddChildNodes per container; their tags go in the same compound as the updates.
  const byRole = {};
  for (const c of p.create) (byRole[c.role] = byRole[c.role] || []).push(c);
  for (const role of Object.keys(byRole)) {
    const container = containers[role];
    const items = byRole[role];
    const b = s.C.AddChildNodesCommandBuilder.create();
    b.setInsertionTarget(container);
    const names = [];
    for (const c of items) {
      const l = layerOf[role + ':' + c.feature.fid];
      const props = c.props;
      const radiusPx = (l.style.pointRadiusPt || 2) * dpi / 72 * drawMapping.scale.sx;
      const pc = polyCurveFor(drawMapping.toPage(c.feature.paths), l.kind, !!c.feature.closed, radiusPx);
      const def = s.N.PolyCurveNodeDefinition.create(pc, fillFor(props.fill), fillFor(props.stroke),
        lineStyleDesc((props.widthPt || 0) * dpi / 72), opaque());
      const name = c.feature.name || c.feature.fid;
      def.setUserDescription(name);
      b.addPolyCurveNode(def);
      names.push(name);
    }
    const before = children(container).length;
    const cmd = b.createCommand(false, s.C.NodeChildType.Main);
    doc.executeCommand(cmd);
    let fromCmd = [];
    try { fromCmd = cmd.newNodes ? [...cmd.newNodes].reverse() : []; } catch (e) { fromCmd = []; }
    const picked = plan.pickCreatedNodes(children(container).slice(before), fromCmd, names, function (n) { return n.userDescription; });
    if (picked.mismatch) warnings.push('Some new objects were matched to features by position only (' + picked.nodes.length + ' of ' + items.length + ').');
    for (let i = 0; i < picked.nodes.length; i++) {
      const id = role + ':' + items[i].feature.fid;
      createTags.push(setTag(doc, picked.nodes[i], 'geo:fid', id));
      createTags.push(setTag(doc, picked.nodes[i], 'geo:sent', JSON.stringify(items[i].props)));
      created.push(id);
    }
  }

  // The "You are here" label. Art text is replaced rather than moved or reformatted: while it
  // is unedited (colour, text and position as last sent) a change of size, text, or where it
  // belongs next to the dot makes a fresh one in its place; a colour change alone recolours it.
  // A hand edit always wins (kept and reported), unless reset.
  if (labelAction === 'create' || labelAction === 'replace') {
    const textPt = wantLabel.textPt;
    const page = drawMapping.toPage([[marker.x, marker.y]])[0];
    const x = page[0] + (RING_PT * dpi / 72 + LABEL_GAP_MM * ppm) * drawMapping.scale.sx;
    const y = page[1] + textPt * dpi / 72 * 0.35;
    const container = containers[MARKER_ROLE] || group;
    const b = s.C.AddChildNodesCommandBuilder.create();
    b.setInsertionTarget(container);
    b.addNode(labelDef(doc, wantLabel.text, x, y, wantLabel.fill, textPt));
    const before = children(container).length;
    const cmd = b.createCommand(false, s.C.NodeChildType.Main);
    doc.executeCommand(cmd);
    // A fresh label is untagged: never mistake the old label (or any map object) for it.
    const fresh = function (n) { return !!n && n !== label && tagOf(n, 'geo:fid') == null; };
    let fromCmd = [];
    try { fromCmd = cmd.newNodes ? [...cmd.newNodes] : []; } catch (e) { fromCmd = []; }
    const node = children(container).slice(before).filter(fresh)[0] || fromCmd.filter(fresh)[0] || null;
    if (!node) {
      // Not where it should be: delete any stray copy (untagged, with the label's name) and
      // leave the old label alone.
      const strays = children(container).filter(function (n) {
        return tagOf(n, 'geo:fid') == null && n.userDescription === wantLabel.text;
      });
      if (strays.length) { try { doc.executeCommand(s.C.DocumentCommand.createDeleteSelection(sel(doc, strays))); } catch (e) { /* ignore */ } }
      warnings.push("AffinityGeo couldn't find the new 'You are here' label after adding it, so " +
        (labelAction === 'replace' ? 'the old one was left as it was' : 'it was not added') + '. Send the map again to retry.');
    } else {
      newLabel = node;
      // Record what the app set, plus how the fresh label reads back (fields that can't be read are left out).
      const sig = labelSignature(node, drawMapping);
      const sent = { fill: wantLabel.fill, textPt: textPt, text: normText(wantLabel.text), at: wantLabel.at,
        last: sig.last !== undefined ? wantLabel.fill : undefined,
        font: sig.font, hPx: sig.hPx, pos: sig.pos, size: sig.size, rot: sig.rot };
      labelCmds.push(setTag(doc, node, 'geo:fid', 'marker:label'));
      labelCmds.push(setTag(doc, node, 'geo:sent', JSON.stringify(sent)));
      if (labelAction === 'create') {
        created.push('marker:label');
      } else {
        // Into the old label's place in the stack, then the old one goes.
        labelCmds.push(s.C.DocumentCommand.createMoveNodes(sel(doc, node), label, s.NodeMoveType.After, s.C.NodeChildType.Main));
        labelCmds.push(s.C.DocumentCommand.createDeleteSelection(sel(doc, label)));
        labelUpdated = true;
      }
    }
  }

  // 7. Updates (per property, batched by value), geo:sent refreshes, removals: ONE compound command.
    const groups = {};
    const add = function (prop, value, node) {
      const key = prop + '|' + JSON.stringify(value);
      (groups[key] = groups[key] || { prop: prop, value: value, nodes: [] }).nodes.push(node);
    };
    for (const u of p.update) {
      for (const prop of Object.keys(u.set)) add(prop, u.set[prop], u.nodeId);
      if (u.geometry) {
        const id = tagOf(u.nodeId, 'geo:fid');
        const l = layerOf[id];
        const kind = l ? l.kind : 'line';
        const radiusPx = ((l && l.style.pointRadiusPt) || 2) * dpi / 72 * drawMapping.scale.sx;
        const pc = polyCurveFor(drawMapping.toPage(u.geometry.paths), kind, !!u.geometry.closed, radiusPx);
        updateCmds.push(s.C.DocumentCommand.createSetCurves(u.nodeId.curvesInterface, toNodeBase(u.nodeId, pc)));
      }
      updateCmds.push(setTag(doc, u.nodeId, 'geo:sent', JSON.stringify(u.sent)));
    }
    for (const key of Object.keys(groups)) {
      const g = groups[key];
      const selection = sel(doc, g.nodes);
      if (g.prop === 'fill') updateCmds.push(s.C.DocumentCommand.createSetBrushFill(selection, fillFor(g.value)));
      else if (g.prop === 'stroke') updateCmds.push(s.C.DocumentCommand.createSetPenFill(selection, fillFor(g.value)));
      else if (g.prop === 'visible') updateCmds.push(s.C.DocumentCommand.createSetVisibility(selection, !!g.value));
      else if (g.prop === 'widthPt') {
        const ls = s.L.LineStyle.createDefault();
        ls.weight = (g.value || 0) * dpi / 72;
        updateCmds.push(s.C.DocumentCommand.createSetLineStyle(selection, ls, { lineStyleMask: s.L.LineStyleMask.Weight }));
      }
    }
    // The label: a colour change alone recolours it in place.
    if (labelAction === 'recolour') {
      if (readTextFill(label) !== wantLabel.fill) updateCmds.push(s.C.DocumentCommand.createSetBrushFill(sel(doc, label), fillFor(wantLabel.fill)));
      const recoloured = Object.assign({}, sentLabel, { fill: wantLabel.fill });
      if (sentLabel.last !== undefined) recoloured.last = wantLabel.fill;
      updateCmds.push(setTag(doc, label, 'geo:sent', JSON.stringify(recoloured)));
      labelUpdated = true;
    } else if (labelAction === 'remove') {
      removed.push(label);
    }
    if (removed.length) updateCmds.push(s.C.DocumentCommand.createDeleteSelection(sel(doc, removed)));
  } catch (e) {
    // Something failed after objects were made: tag them before giving up (no orphans).
    try { run(doc, createTags); } catch (e2) { /* ignore */ }
    dropNewLabel();
    throw e;
  }
  try {
    run(doc, createTags.concat(labelCmds, updateCmds));
  } catch (e) {
    try { run(doc, createTags); } catch (e2) { /* ignore */ }
    dropNewLabel();
    throw e;
  }

  // 8. Result.
  const removedSet = new Set(p.remove);
  const ids = new Set();
  for (const e of existing) if (!removedSet.has(e.nodeId)) ids.add(e.id);
  for (const id of created) ids.add(id);
  // Deleted by the designer and still in the job: remembered as sent, so they stay deleted.
  for (const id of p.deletedIds || []) ids.add(id);
  if ((label && labelAction !== 'remove') || labelDeleted) ids.add('marker:label');
  const keptEdited = p.keptEdited.map(function (k) {
    let name;
    try { name = String(k.nodeId.userDescription || ''); } catch (e) { name = ''; }
    const id = tagOf(k.nodeId, 'geo:fid');
    const parts = splitId(id) || { role: '', fid: k.fid };
    return { fid: k.fid, role: parts.role, name: name, reason: k.reason };
  });
  if (labelKept) {
    const t = readText(label);
    let name = t;
    if (name == null) { try { name = String(label.userDescription || ''); } catch (e) { name = ''; } }
    keptEdited.push({ fid: 'label', role: MARKER_ROLE, name: name, reason: 'edited by hand' });
  }
  return {
    created: created.length,
    updated: p.update.filter(function (u) { return Object.keys(u.set).length || u.geometry; }).length + (labelUpdated ? 1 : 0),
    removed: removed.length,
    keptEdited: keptEdited,
    resized: resized,
    warnings: warnings,
    skipped: norm.skipped,
    objectIds: Array.from(ids),
    docId: docId(doc),
    docTitle: docTitle(doc),
  };
}

// ---------- selectOnMap ----------

/** selectOnMap(documents, { projectId, mapId, role, fids }) → { selected } */
function selectOnMap(documents, payload) {
  const s = sdk();
  const found = findMapArtboards(documents, payload.projectId, payload.mapId);
  for (const f of found) {
    const group = findFrameGroup(f.doc, f.node, payload.projectId, payload.mapId);
    if (!group) continue;
    const want = new Set((payload.fids || []).map(function (fid) { return payload.role + ':' + fid; }));
    const nodes = collectObjects(group, [], 3).filter(function (o) { return want.has(o.id); }).map(function (o) { return o.node; });
    f.doc.executeCommand(s.C.DocumentCommand.createSetSelection(sel(f.doc, nodes)));
    return { selected: nodes.length };
  }
  throw new Error(NO_MAP);
}

// ---------- linkArtboard ----------

const ARTBOARDS_CHANGED = 'The artboards changed in Affinity. Pick the artboard again.';

/**
 * linkArtboard(documents, { projectId, mapId, docId, artboardIndex, artboardName, otherMapNames })
 *   → { ok: true, docId, docTitle }
 * Points a map at an existing artboard: tags it geo:map {projectId, mapId}. The index is into the
 * same artboard list listTargets reports; the name must still match, or the list moved on.
 * The map's tag comes off any other artboard of that document first (a map has one artboard).
 * Refuses an artboard tagged for another map of the same project; one tagged by a different
 * project is re-linked (the designer chose it). otherMapNames: mapId → name, for the message.
 */
function linkArtboard(documents, payload) {
  let doc = null;
  for (const d of documents || []) if (docId(d) === String(payload.docId)) { doc = d; break; }
  if (!doc) throw new Error('Open the document in Affinity, then pick the artboard again.');
  const abs = artboardsOf(doc);
  const ab = abs[payload.artboardIndex];
  let node;
  try { node = ab ? ab.node : null; } catch (e) { node = null; }
  if (!ab || !node || artboardName(ab, node) !== String(payload.artboardName)) throw new Error(ARTBOARDS_CHANGED);

  const existing = parseJson(tagOf(node, 'geo:map'));
  const names = payload.otherMapNames || {};
  // A map the app no longer has (deleted there) doesn't hold its artboard any more.
  if (existing && existing.projectId === payload.projectId && existing.mapId !== payload.mapId &&
      Object.prototype.hasOwnProperty.call(names, existing.mapId)) {
    throw new Error("That artboard already holds '" + (names[existing.mapId] || existing.mapId) + "'.");
  }
  const cmds = [];
  for (const other of abs) {
    if (other === ab) continue;
    let n;
    try { n = other.node; } catch (e) { continue; }
    if (n && n !== node && sameMap(tagOf(n, 'geo:map'), payload.projectId, payload.mapId)) cmds.push(setTag(doc, n, 'geo:map', ''));
  }
  // The map's old frame groups (anywhere but on the chosen artboard) are let go: no tag, renamed
  // "(unlinked)". Their objects become the designer's own, so the next send makes a fresh frame here.
  const s = sdk();
  for (const g of allFrameGroups(doc, payload.projectId, payload.mapId)) {
    let inside = false;
    for (let p = g.parent; p; p = p.parent) if (p === node) { inside = true; break; }
    if (inside) continue;
    let name;
    try { name = String(g.userDescription || ''); } catch (e) { name = ''; }
    cmds.push(setTag(doc, g, 'geo:mapframe', ''));
    cmds.push(s.C.DocumentCommand.createSetDescription(sel(doc, g), name + ' (unlinked)'));
  }
  cmds.push(setTag(doc, node, 'geo:map', JSON.stringify({ projectId: payload.projectId, mapId: payload.mapId })));
  run(doc, cmds);
  return { ok: true, docId: docId(doc), docTitle: docTitle(doc) };
}

/** Test hook: run against a fake SDK in Node (test/fake-sdk.js). */
function _useSdk(fake) { S = fake; }

module.exports = {
  _useSdk: _useSdk,
  listTargets: listTargets,
  sendMap: sendMap,
  selectOnMap: selectOnMap,
  linkArtboard: linkArtboard,
  readProps: readProps,
  // pure helpers (tested in Node)
  normaliseJob: normaliseJob,
  colourHex: colourHex,
  sameMap: sameMap,
  splitId: splitId,
  nextArtboardX: nextArtboardX,
  placeFrame: placeFrame,
  resizedFrame: resizedFrame,
  frameMapping: frameMapping,
  signatureFromRead: signatureFromRead,
  notOpenMessage: notOpenMessage,
  OUTLINE_BACK: OUTLINE_BACK,
  NO_MAP: NO_MAP,
};
