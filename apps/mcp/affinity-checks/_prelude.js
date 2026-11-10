// Shared helpers, put in front of every check by the affinity_check tool (each Affinity MCP call starts
// from an empty scope, so a check must carry everything it uses). Reading only: nothing here changes the document.
const { Document } = require('/document.js');
const N = require('/nodes.js');
const C = require('/commands.js');
const doc = Document.current;

function list(collection) { try { return collection ? [...collection] : []; } catch (e) { return []; } }
function kids(node) { try { return node && node.children ? [...node.children] : []; } catch (e) { return []; } }
// A group's mask is in its Enclosure child list, not among its ordinary children.
function enclosures(node) {
  try { return node ? [...new N.NodeChildren(node.handle, C.NodeChildType.Enclosure)] : []; } catch (e) { return []; }
}
// getValueForKey throws for a key the node doesn't have: ask hasKey first.
function tagOf(node, key) {
  try {
    if (!node || !node.hasKey(key)) return null;
    const v = node.getValueForKey(key);
    return v == null || v === '' ? null : String(v);
  } catch (e) { return null; }
}
function parseJson(text) { try { return text == null ? null : JSON.parse(text); } catch (e) { return null; } }
function nameOf(node) { try { return String((node && node.userDescription) || ''); } catch (e) { return ''; } }
function same(a, b) { try { return !!a && !!b && a.isSameNode(b); } catch (e) { return false; } }
function artboards() {
  const out = [];
  for (const sp of list(doc.spreads)) { try { for (const ab of sp.artboards) out.push(ab); } catch (e) { /* not an artboard spread */ } }
  if (!out.length) { try { for (const ab of doc.artboards) out.push(ab); } catch (e) { /* none */ } }
  return out;
}
// Top-level nodes to search: every artboard, then any layer that is not one of those artboards.
function roots() {
  const boards = artboards().map(function (ab) { return ab.node; });
  const loose = list(doc.layers).filter(function (n) { return !boards.some(function (b) { return same(b, n); }); });
  return boards.concat(loose);
}
// Visits a node's descendants, masks included. fn(node, parent, isMask).
function walk(node, fn, depth) {
  if ((depth || 0) > 12) return;
  for (const c of enclosures(node)) { fn(c, node, true); walk(c, fn, (depth || 0) + 1); }
  for (const c of kids(node)) { fn(c, node, false); walk(c, fn, (depth || 0) + 1); }
}
function mm(px) { return Math.round((px * 25.4 / doc.dpi) * 100) / 100; }
function report(result) { console.log(JSON.stringify(doc ? result : { error: 'No document is open in Affinity.' }, null, 1)); }
