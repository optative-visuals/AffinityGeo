// AffinityGeo – plan.js (GPL-3.0-or-later)
// Pure helpers for drawing a map job: drawable paths, frame mapping, matching new nodes.
// No SDK requires: runs in Affinity and in Node tests.
'use strict';

function round2(v) {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}

/** Fewest numbers a path needs to be drawn: a point 1 position, a line 2, a ring 3. */
function minNumbers(kind, closed) {
  if (kind === 'point') return 2;
  return closed ? 6 : 4;
}

/** The paths of a job feature that can actually be drawn. A feature with none is skipped, never an empty object. */
function drawablePaths(feature, kind) {
  const min = minNumbers(kind, !!(feature && feature.closed));
  const out = [];
  for (const p of (feature && feature.paths) || []) if (Array.isArray(p) && p.length >= min) out.push(p);
  return out;
}

const STRETCH_TOLERANCE = 0.01;
const ROTATION_TOLERANCE = 1e-6; // radians

/** How the job's page rect maps onto the frame outline's current box. */
function frameBoxScale(rect, box) {
  const s = box.width / rect.width;
  const sy = box.height / rect.height;
  const stretched = Math.abs(sy - s) > STRETCH_TOLERANCE * s;
  return { sx: s, sy: stretched ? sy : s, stretched: stretched };
}

/**
 * Map page coordinates made for the frame's stored rect onto where the frame
 * outline is now (the designer may have moved or scaled the frame group):
 * x' = box.x + (x - rect.x) * sx, y' = box.y + (y - rect.y) * sy.
 * Uniform scale (box.width / rect.width) unless the height differs by more
 * than 1 %, when x and y scale separately.
 */
function mapToFrameBox(paths, rect, box) {
  if (!rect || !box || !(rect.width > 0 && rect.height > 0 && box.width > 0 && box.height > 0)) return paths;
  const k = frameBoxScale(rect, box);
  if (k.sx === 1 && k.sy === 1 && box.x === rect.x && box.y === rect.y) return paths;
  return (paths || []).map(function (p) {
    const out = new Array(p.length);
    for (let i = 0; i + 1 < p.length; i += 2) {
      out[i] = round2(box.x + (p[i] - rect.x) * k.sx);
      out[i + 1] = round2(box.y + (p[i + 1] - rect.y) * k.sy);
    }
    return out;
  });
}

/** Plain-English warnings about a frame outline the designer stretched or rotated. rotation is in radians. */
function frameBoxWarnings(rect, box, rotation) {
  const out = [];
  if (rect && box && rect.width > 0 && rect.height > 0 && box.width > 0 && box.height > 0 && frameBoxScale(rect, box).stretched) {
    out.push('The map frame was stretched, so the map is stretched to fit it.');
  }
  if (typeof rotation === 'number' && Math.abs(rotation) > ROTATION_TOLERANCE) {
    out.push('The map frame is rotated; AffinityGeo draws it unrotated.');
  }
  return out;
}

/**
 * Which nodes did one AddChildNodes command just create, in feature order?
 * Affinity 3.3.1 appends new children in add order but lists cmd.newNodes in
 * reverse, so prefer the children slice, then the reversed newNodes, checking
 * names. If neither matches, still return the children slice (flagged) so
 * every new object is tagged rather than left orphaned.
 */
function pickCreatedNodes(slice, reversedNewNodes, wantNames, nameOf) {
  const matches = function (nodes) {
    if (!nodes || nodes.length !== wantNames.length) return false;
    for (let i = 0; i < nodes.length; i++) if (nameOf(nodes[i]) !== wantNames[i]) return false;
    return true;
  };
  if (matches(slice)) return { nodes: slice, mismatch: false };
  if (matches(reversedNewNodes)) return { nodes: reversedNewNodes, mismatch: false };
  const s = slice || [];
  return { nodes: s.length > wantNames.length ? s.slice(0, wantNames.length) : s, mismatch: true };
}

module.exports = {
  pickCreatedNodes: pickCreatedNodes,
  drawablePaths: drawablePaths,
  mapToFrameBox: mapToFrameBox,
  frameBoxScale: frameBoxScale,
  frameBoxWarnings: frameBoxWarnings,
};
