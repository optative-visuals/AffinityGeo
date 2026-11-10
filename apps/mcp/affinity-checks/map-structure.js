// The layer structure of every map AffinityGeo has drawn: its frame group, data layers in order, the Location group and whether it has a real mask, and the Surrounding context group.
// Not yet confirmed live.
report(doc && (function () {
  function layer(n) {
    return {
      name: nameOf(n), role: tagOf(n, 'geo:role'), children: kids(n).length,
      objects: kids(n).filter(function (c) { return tagOf(c, 'geo:fid') != null; }).length,
    };
  }
  function fillOf(n) {
    try { return String(n.brushFillDescriptor.fill).replace('[object ', '').replace(']', ''); } catch (e) { return null; }
  }
  function frame(group) {
    const inside = kids(group);
    const byRole = function (role) { return inside.filter(function (c) { return tagOf(c, 'geo:fid') == null && tagOf(c, 'geo:role') === role; })[0] || null; };
    const location = byRole('location');
    const context = byRole('context');
    const mask = location ? enclosures(location).filter(function (c) { return tagOf(c, 'geo:fid') === 'mask:shape'; })[0] || null : null;
    const out = {
      name: nameOf(group), tag: parseJson(tagOf(group, 'geo:mapframe')),
      // In the document's own child order.
      layers: inside.map(layer),
      location: location ? {
        masked: !!mask, maskName: mask ? nameOf(mask) : null, maskFill: mask ? fillOf(mask) : null,
        enclosureCount: enclosures(location).length, layers: kids(location).map(layer),
      } : null,
      context: context ? { layers: kids(context).map(layer) } : null,
      // A mask shape left among the ordinary children is a fault (it would draw, or clip the old way).
      strayMasks: inside.filter(function (c) { return tagOf(c, 'geo:fid') === 'mask:shape'; }).length,
    };
    return out;
  }
  const maps = [];
  for (const root of roots()) {
    const frames = [];
    if (tagOf(root, 'geo:mapframe') != null) frames.push(frame(root));
    walk(root, function (c) { if (tagOf(c, 'geo:mapframe') != null) frames.push(frame(c)); }, 8);
    const map = parseJson(tagOf(root, 'geo:map'));
    if (map || frames.length) maps.push({ artboard: nameOf(root), map: map, frames: frames });
  }
  return { title: String(doc.title), maps: maps };
})());
