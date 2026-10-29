// Pure send planner: decides per object and per property what to create,
// update, remove or leave alone. A property the designer changed by hand in
// Affinity (current differs from what we last sent) always wins.
// Plain CommonJS, no requires: it runs inside Affinity's JS runtime.

var PROPS = ["fill", "stroke", "widthPt", "visible", "geom"];

// GEOMETRY SIGNATURE RULE (what draw-map.js must compute from what it reads back, in mm):
//   points         -> "p:cx,cy"      the centre (bbox centre), rounded to 0.1 mm
//   lines/polygons -> "n:x,y,w,h"    n = total node count, bbox rounded to 0.1 mm;
//                                    a repeated closing point (last == first within
//                                    0.01 mm) is NOT counted.
// Signatures are compared with geomSame(): same prefix/count exactly, numbers within 0.15 mm.
function round1(v) {
  var r = Math.round(v * 10) / 10;
  return r === 0 ? 0 : r;
}

function geomSignature(paths, kind) {
  var n = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (var i = 0; i < paths.length; i++) {
    var p = paths[i];
    var len = p.length - (p.length % 2);
    if (len >= 4 && Math.abs(p[0] - p[len - 2]) <= 0.01 && Math.abs(p[1] - p[len - 1]) <= 0.01) len -= 2;
    for (var j = 0; j < len; j += 2) {
      n++;
      if (p[j] < minX) minX = p[j];
      if (p[j] > maxX) maxX = p[j];
      if (p[j + 1] < minY) minY = p[j + 1];
      if (p[j + 1] > maxY) maxY = p[j + 1];
    }
  }
  if (kind === "point") {
    if (n === 0) return "p:0,0";
    return "p:" + round1((minX + maxX) / 2) + "," + round1((minY + maxY) / 2);
  }
  if (n === 0) return "0:0,0,0,0";
  return n + ":" + round1(minX) + "," + round1(minY) + "," + round1(maxX - minX) + "," + round1(maxY - minY);
}

function geomSame(a, b) {
  if (a === b) return true;
  if (typeof a !== "string" || typeof b !== "string") return false;
  var ia = a.indexOf(":"), ib = b.indexOf(":");
  if (ia < 0 || ib < 0 || a.slice(0, ia) !== b.slice(0, ib)) return false;
  var na = a.slice(ia + 1).split(","), nb = b.slice(ib + 1).split(",");
  if (na.length !== nb.length) return false;
  for (var i = 0; i < na.length; i++) {
    if (Math.abs(parseFloat(na[i]) - parseFloat(nb[i])) > 0.15 + 1e-9) return false;
  }
  return true;
}

function normColour(c) {
  return c === null || c === undefined ? null : String(c).toLowerCase();
}

function propsFromStyle(style, feature, kind) {
  return {
    fill: normColour(style.fill),
    stroke: normColour(style.stroke),
    widthPt: style.strokePt,
    visible: !!style.visible,
    geom: geomSignature(feature.paths, kind),
  };
}

function same(p, a, b) {
  if (p === "widthPt") return Math.abs(a - b) <= 0.01;
  if (p === "fill" || p === "stroke") return normColour(a) === normColour(b);
  if (p === "geom") return geomSame(a, b);
  return a === b;
}

function differsFromSent(n) {
  if (!n.sent) return false;
  for (var i = 0; i < PROPS.length; i++) {
    if (!same(PROPS[i], n.current[PROPS[i]], n.sent[PROPS[i]])) return true;
  }
  return false;
}

function pickOriginals(existing) {
  var groups = {}, order = [];
  existing.forEach(function (n) {
    if (!groups[n.id]) { groups[n.id] = []; order.push(n.id); }
    groups[n.id].push(n);
  });
  return order.map(function (id) {
    var g = groups[id];
    if (g.length > 1) {
      for (var i = 0; i < g.length; i++) {
        if (g[i].sent && geomSame(g[i].current.geom, g[i].sent.geom)) return g[i];
      }
    }
    return g[0];
  });
}

function planSend(existing, job, opts) {
  var reset = !!(opts && opts.reset);
  var sentIds = (opts && opts.sentIds) || [];
  // deletedIds: sent before, still in the job, deleted by the designer, so not recreated.
  // The caller remembers them as sent, so they stay deleted on later sends too.
  var plan = { create: [], update: [], remove: [], keptEdited: [], warnings: [], deletedIds: [] };

  var desired = {}, desiredOrder = [];
  job.layers.forEach(function (layer) {
    layer.features.forEach(function (f) {
      var id = layer.role + ":" + f.fid;
      desired[id] = { role: layer.role, feature: f, props: propsFromStyle(layer.style, f, layer.kind) };
      desiredOrder.push(id);
    });
  });

  var originals = pickOriginals(existing);
  var byId = {};
  originals.forEach(function (n) { byId[n.id] = n; });

  // Objects no longer in the job (layer order = order given).
  originals.forEach(function (n) {
    if (desired[n.id]) return;
    if (!reset && differsFromSent(n)) {
      plan.keptEdited.push({ nodeId: n.nodeId, fid: n.fid, reason: "outside the map" });
    } else {
      plan.remove.push(n.nodeId);
    }
  });

  var deleted = 0;
  desiredOrder.forEach(function (id) {
    var d = desired[id], n = byId[id];
    if (!n) {
      if (!reset && sentIds.indexOf(id) !== -1) { deleted++; plan.deletedIds.push(id); return; }
      plan.create.push({ role: d.role, feature: d.feature, props: d.props });
      return;
    }
    var base = n.sent || n.current;
    var set = {}, sent = {}, geometry, keptGeom = false, keptOther = false;
    PROPS.forEach(function (p) {
      if (reset || same(p, n.current[p], base[p])) {
        sent[p] = d.props[p];
        if (!same(p, n.current[p], d.props[p])) {
          if (p === "geom") geometry = d.feature; else set[p] = d.props[p];
        }
      } else {
        sent[p] = base[p];
        if (!same(p, n.current[p], d.props[p])) {
          if (p === "geom") keptGeom = true; else keptOther = true;
        }
      }
    });
    if (keptGeom || keptOther) {
      plan.keptEdited.push({ nodeId: n.nodeId, fid: n.fid, reason: keptGeom ? "reshaped" : "edited by hand" });
    }
    var sentChanged = !n.sent || PROPS.some(function (p) { return !same(p, n.sent[p], sent[p]); });
    if (Object.keys(set).length || geometry || sentChanged) {
      var u = { nodeId: n.nodeId, set: set, sent: sent };
      if (geometry) u.geometry = geometry;
      plan.update.push(u);
    }
  });

  if (deleted) {
    plan.warnings.push(deleted === 1
      ? "1 object you deleted was not recreated"
      : deleted + " objects you deleted were not recreated");
  }
  return plan;
}

module.exports = {
  planSend: planSend,
  geomSignature: geomSignature,
  geomSame: geomSame,
  propsFromStyle: propsFromStyle,
};
