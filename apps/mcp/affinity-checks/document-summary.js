// A first look at the current Affinity document: artboards, top-level layers and how many objects AffinityGeo drew.
// Not yet confirmed live.
report(doc && (function () {
  let tagged = 0, masks = 0;
  const top = roots().map(function (n) {
    walk(n, function (c, _parent, isMask) { if (tagOf(c, 'geo:fid') != null) tagged++; if (isMask) masks++; });
    return { name: nameOf(n), children: kids(n).length, map: parseJson(tagOf(n, 'geo:map')) };
  });
  return {
    title: String(doc.title), dpi: doc.dpi,
    artboards: artboards().map(function (ab) {
      let box = null;
      try { box = ab.spreadBaseBox; } catch (e) { /* older SDK */ }
      return { name: nameOf(ab.node), widthMm: box ? mm(box.width) : null, heightMm: box ? mm(box.height) : null, isMap: tagOf(ab.node, 'geo:map') != null };
    }),
    topLevel: top, taggedObjects: tagged, masks: masks,
  };
})());
