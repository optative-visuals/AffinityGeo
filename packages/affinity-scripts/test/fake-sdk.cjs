// A small in-memory stand-in for the parts of the Affinity SDK that draw-map.js uses,
// so the whole send flow can run in Node. It mimics the verified behaviours:
//  - children in add order, cmd.newNodes reversed;
//  - getValueForKey throws for a missing key;
//  - every node has a local transform (translate + uniform scale); baseToSpreadTransform is the
//    composition of its ancestors' transforms and its own, and polyCurve is in BASE space;
//  - a child added into a transformed group takes spread coordinates (Affinity gives it the
//    inverse of the group's transform); createSetCurves writes base space.
// Hooks (fake.hooks) let tests make an AddChildNodes command or a compound command fail.
// It is NOT a substitute for the MCP check.
'use strict';

let nextId = 1;

class Rectangle { constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); } }

/** x' = a·x + tx, y' = a·y + ty */
class Transform {
  constructor(a = 1, tx = 0, ty = 0) { this.a = a; this.tx = tx; this.ty = ty; }
  apply(x, y) { return [this.a * x + this.tx, this.a * y + this.ty]; }
  get inverted() { return new Transform(1 / this.a, -this.tx / this.a, -this.ty / this.a); }
  decompose() { return { translateX: this.tx, translateY: this.ty, scaleX: this.a, scaleY: this.a, rotation: 0, shear: 0 }; }
  static compose(outer, inner) { return new Transform(outer.a * inner.a, outer.a * inner.tx + outer.tx, outer.a * inner.ty + outer.ty); }
}

function bboxOfPts(pts) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, y] of pts) { a = Math.min(a, x); c = Math.max(c, x); b = Math.min(b, y); d = Math.max(d, y); }
  return pts.length ? { x: a, y: b, width: c - a, height: d - b } : null;
}

class FakeCurve {
  constructor(pts, closed, ellipse) { this.pts = pts; this.closed = closed; this.ellipse = ellipse || null; }
  get isClosed() { return this.closed; }
  transformed(xf) {
    if (this.ellipse) {
      const [cx, cy] = xf.apply(this.ellipse.cx, this.ellipse.cy);
      return new FakeCurve([], true, { cx, cy, r: this.ellipse.r * xf.a });
    }
    return new FakeCurve(this.pts.map(([x, y]) => xf.apply(x, y)), this.closed);
  }
  get beziers() {
    const pts = this.ellipse
      ? [[this.ellipse.cx + this.ellipse.r, this.ellipse.cy], [this.ellipse.cx, this.ellipse.cy + this.ellipse.r],
        [this.ellipse.cx - this.ellipse.r, this.ellipse.cy], [this.ellipse.cx, this.ellipse.cy - this.ellipse.r]]
      : this.pts;
    const out = [];
    const n = this.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const s = pts[i], e = pts[(i + 1) % pts.length];
      out.push({ start: { x: s[0], y: s[1] }, end: { x: e[0], y: e[1] } });
    }
    return out;
  }
  extent() {
    if (this.ellipse) { const { cx, cy, r } = this.ellipse; return [[cx - r, cy - r], [cx + r, cy + r]]; }
    return this.pts;
  }
}

class PolyCurve {
  constructor() { this.curves = []; }
  addCurve(c) { this.curves.push(c); }
  clone() { const p = new PolyCurve(); p.curves = this.curves.slice(); return p; }
  transform(xf) { this.curves = this.curves.map((c) => c.transformed(xf)); return this; }
  get curveCount() { return this.curves.length; }
  at(i) { return this.curves[i]; }
  get boundingBox() { return bboxOfPts(this.curves.flatMap((c) => c.extent())); }
}

const Curve = { createEllipse: (r) => new FakeCurve([], true, { cx: r.x + r.width / 2, cy: r.y + r.height / 2, r: r.width / 2 }) };
const CurveBuilder = {
  create() {
    const pts = []; let closed = false;
    return { beginXY(x, y) { pts.push([x, y]); }, lineToXY(x, y) { pts.push([x, y]); }, close() { closed = true; }, createCurve: () => new FakeCurve(pts, closed) };
  },
};

// The artistic text default style's font (setToArtisticTextDefaultStyle).
const DEFAULT_FONT = { postscriptName: 'ArialMT', familyName: 'Arial', traitsName: 'Regular' };

function fillDesc(hex) {
  const fill = hex == null
    ? { toString: () => '[object NoFill]' }
    : { toString: () => '[object SolidFill]', colour: { rgba8: { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), alpha: 255 } } };
  return { fill, hex };
}

class Node {
  constructor(kind, name) {
    this.id = nextId++; this.kind = kind; this.userDescription = name || ''; this.tags = new Map(); this.kids = []; this.parent = null;
    this.pc = null; this._text = undefined; this.textPx = null; this.font = null; this.charFills = null; this.unreadable = new Set(); this.fillHex = null; this.penHex = null; this.weight = 0; this.visible = true; this.box = null;
    this.xf = new Transform();
  }
  get children() { return this.kids.slice(); }
  hasKey(k) { return this.tags.has(k); }
  getValueForKey(k) { if (!this.tags.has(k)) throw new Error('INVALID_ARGS'); return this.tags.get(k); }
  // Like Affinity: art text reports NoFill on the node; its colour lives in the story's glyph attributes.
  get brushFillDescriptor() { return fillDesc(this.kind === 'text' ? null : this.fillHex); }
  // Art text: one glyph per character; colour per glyph (charFills overrides by position), height in px
  // (as StoryDelta.createGlyphDouble(GlyphAttDoubleType.Height, px)), and a Font handle with name getters.
  // unreadable: names of reads that throw ("fill", "height", "font", "box", "text"), to test guards.
  get story() {
    if (this.kind !== 'text') return undefined;
    const node = this;
    const guard = (what, v) => { if (node.unreadable.has(what)) throw new Error('Fake: unreadable ' + what); return v; };
    return {
      get length() { return guard('text', String(node.text).length); },
      getGlyphAtts: (pos) => ({
        get brushFill() { return guard('fill', fillDesc(node.charFills && node.charFills[pos] != null ? node.charFills[pos] : node.fillHex)); },
        get height() { return guard('height', node.textPx); },
        get font() { return guard('font', node.font); },
      }),
    };
  }
  get text() { if (this.unreadable && this.unreadable.has('text')) throw new Error('Fake: unreadable text'); return this._text; }
  set text(v) { this._text = v; }
  get penFillDescriptor() { return fillDesc(this.penHex); }
  get lineWeight() { return this.weight; }
  get isLineStyleVisible() { return true; }
  get lineType() { return 'Solid'; }
  get isVisible() { return this.visible; }
  get polyCurve() { return this.pc; }
  get baseToSpreadTransform() { return this.parent ? Transform.compose(this.parent.baseToSpreadTransform, this.xf) : this.xf; }
  get curvesInterface() { return { node: this }; }
  get spreadBaseBox() {
    if (this.unreadable && this.unreadable.has('box')) throw new Error('Fake: unreadable box');
    if (this.box) return { ...this.box };
    return this.pc ? this.pc.clone().transform(this.baseToSpreadTransform).boundingBox : null;
  }
  /** Test helper: the node's curves in spread space. */
  spreadCurve() { return this.pc.clone().transform(this.baseToSpreadTransform); }
}

function makeDoc(opts = {}) {
  const spreadKids = [];
  const doc = {
    dpi: opts.dpi || 72, title: opts.title || 'Sign.af', persistentUuid: opts.uuid || 'doc-1', rasterFormat: 0, log: [],
    executeCommand(cmd) { doc.log.push(cmd.label || 'cmd'); cmd.exec(); return cmd; },
    get layers() { return spreadKids.slice(); },
    get spreads() { return [spread]; },
    get currentSpread() { return spread; },
    addRectangularArtboard(rect) { return addArtboard(rect); },
    selection: [],
  };
  const artboardIface = (node) => ({
    node,
    get spreadBaseBox() { return { ...node.box }; },
    isSameObject: (o) => o.node === node,
  });
  const spread = { get artboards() { return spreadKids.filter((n) => n.kind === 'artboard').map(artboardIface); } };
  function addArtboard(rect) {
    const n = new Node('artboard', 'Artboard');
    n.box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    spreadKids.push(n);
    return n;
  }
  doc.addArtboard = addArtboard;
  doc.allNodes = () => { const out = []; const walk = (ns) => ns.forEach((n) => { out.push(n); walk(n.kids); }); walk(spreadKids); return out; };
  doc.remove = (node) => { const p = node.parent; if (p) p.kids.splice(p.kids.indexOf(node), 1); else spreadKids.splice(spreadKids.indexOf(node), 1); node.parent = null; };
  return doc;
}

function command(label, exec) { return { label, exec }; }

function fakeSdk() {
  const hooks = { failAdd: null, failCompound: null, loseAdded: null };
  const C = {
    NodeChildType: { Main: 'main' },
    AddChildNodesCommandBuilder: {
      create() {
        let target = null; const defs = [];
        return {
          setInsertionTarget(t) { target = t; },
          addContainerNode(d) { defs.push(d); }, addPolyCurveNode(d) { defs.push(d); }, addNode(d) { defs.push(d); },
          createCommand() {
            const made = [];
            const cmd = command('add', () => {
              if (hooks.failAdd && hooks.failAdd(defs, target)) throw new Error('Fake: add failed');
              // A child added into a transformed parent keeps its spread position.
              const inv = target.baseToSpreadTransform.inverted;
              for (const d of defs) {
                const n = new Node(d.kind, d.name);
                Object.assign(n, d.init || {});
                n.xf = inv;
                n.parent = target;
                // loseAdded: the new node lands where the caller won't look, and newNodes is empty.
                if (hooks.loseAdded && hooks.loseAdded(defs, target)) target.kids.unshift(n); else { target.kids.push(n); made.push(n); }
              }
            });
            Object.defineProperty(cmd, 'newNodes', { get: () => made.slice().reverse() });
            return cmd;
          },
        };
      },
    },
    CompoundCommandBuilder: {
      create() {
        const cmds = [];
        return {
          addCommand(c) { cmds.push(c); },
          // Atomic like Affinity's: a failing compound changes nothing.
          createCommand: () => command('compound', () => {
            if (hooks.failCompound && hooks.failCompound(cmds)) throw new Error('Fake: compound failed');
            cmds.forEach((c) => c.exec());
          }),
        };
      },
    },
    DocumentCommand: {
      createSetTagValueForKey: (s, k, v) => command('tag:' + k, () => s.nodes.forEach((n) => n.tags.set(k, v))),
      createSetDescription: (s, d) => command('name', () => s.nodes.forEach((n) => { n.userDescription = d; })),
      createSetBrushFill: (s, fd) => command('fill', () => s.nodes.forEach((n) => { n.fillHex = fd.hex; n.charFills = null; })),
      createSetPenFill: (s, fd) => command('pen', () => s.nodes.forEach((n) => { n.penHex = fd.hex; })),
      createSetVisibility: (s, v) => command('vis', () => s.nodes.forEach((n) => { n.visible = v; })),
      createSetLineStyle: (s, ls) => command('weight', () => s.nodes.forEach((n) => { n.weight = ls.weight; })),
      createSetCurves: (ci, pc) => command('curves', () => { ci.node.pc = pc; }),
      createDeleteSelection: (s) => command('delete', () => s.nodes.forEach((n) => s.doc.remove(n))),
      createMoveNodes: (s, target, type) => command('move', () => s.nodes.forEach((n) => {
        const p = target.parent; n.parent.kids.splice(n.parent.kids.indexOf(n), 1);
        const i = p.kids.indexOf(target); p.kids.splice(type === 'After' ? i + 1 : i, 0, n); n.parent = p;
      })),
      createSetSelection: (s) => command('select', () => { s.doc.selection = s.nodes; }),
      createSetArtboardSizeWithAnchor: (ab, w, h) => command('resize', () => { ab.node.box.width = w; ab.node.box.height = h; }),
    },
  };

  const N = {
    ContainerNodeDefinition: { createDefault: () => ({ kind: 'container', name: '', setUserDescription(d) { this.name = d; } }) },
    PolyCurveNodeDefinition: {
      create: (pc, fill, pen, ls, transparency) => {
        if (!transparency || transparency.hex !== '#ffffff') throw new Error('transparency must be opaque white');
        return { kind: 'curve', name: '', init: { pc, fillHex: fill.hex, penHex: pen.hex, weight: ls.weight }, setUserDescription(d) { this.name = d; } };
      },
    },
    ArtTextNodeDefinition: {
      // The point is the baseline start; the box grows with the text size and length (spreadBaseBox via pc).
      createFromStoryBuilder: (pt, sb) => {
        const h = sb.height || 12;
        const pc = new PolyCurve();
        pc.addCurve(new FakeCurve([[pt.x, pt.y - 0.75 * h], [pt.x + 0.5 * h * sb.text.length, pt.y + 0.25 * h]], true));
        return { kind: 'text', name: '', init: { pc, fillHex: sb.fill, text: sb.text, textPx: h, font: { ...DEFAULT_FONT } }, setUserDescription(d) { this.name = d; } };
      },
    },
  };

  return {
    hooks,
    C, N, G: { PolyCurve, Curve, CurveBuilder, Rectangle },
    FillDescriptor: { createSolid: (c) => ({ hex: '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('') }), createNone: () => ({ hex: null }) },
    Colour: { createRGBA8: (o) => ({ ...o }) },
    L: {
      LineStyleDescriptor: { create: (ls) => ({ weight: ls.weight }) },
      LineStyle: { createDefaultWithWeight: (w) => ({ weight: w }), createDefault: () => ({ weight: 1 }) },
      LineStyleMask: { Weight: 'weight' },
    },
    BlendMode: { Normal: 'normal' },
    Selection: { create: (doc, nodes) => ({ doc, nodes: Array.isArray(nodes) ? nodes : [nodes] }) },
    SpatialAnchor: { TopLeft: 'tl' },
    NodeMoveType: { After: 'After', Before: 'Before' },
    StoryBuilder: { create: () => ({ fill: null, text: '', height: null, setToArtisticTextDefaultStyle() {}, applyGlyphDelta(d) { if (d.fill) this.fill = d.fill.hex; if (d.height) this.height = d.height; }, addText(t) { this.text += t; } }) },
    StoryDelta: { createGlyphDouble: (type, v) => (type === 'h' ? { height: v } : {}), createBrushFill: (fd) => ({ fill: fd }) },
    GlyphAttDoubleType: { Height: 'h' },
  };
}

module.exports = { fakeSdk, makeDoc, Node, Transform };
