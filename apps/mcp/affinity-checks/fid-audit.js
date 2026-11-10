// Counts the objects AffinityGeo drew (geo:fid tags) per layer, and lists any id that appears twice in one map (a duplicated or copied object) or has no geo:sent record.
// Not yet confirmed live.
report(doc && (function () {
  let total = 0, withoutSent = 0;
  const byLayer = {};
  const duplicates = [];
  for (const root of roots()) {
    const seen = {};
    walk(root, function (c, parent) {
      const fid = tagOf(c, 'geo:fid');
      if (fid == null) return;
      total++;
      if (tagOf(c, 'geo:sent') == null) withoutSent++;
      const where = nameOf(root) + ' / ' + (tagOf(parent, 'geo:role') || nameOf(parent) || '(no name)');
      byLayer[where] = (byLayer[where] || 0) + 1;
      seen[fid] = (seen[fid] || 0) + 1;
    });
    for (const fid of Object.keys(seen)) if (seen[fid] > 1) duplicates.push({ artboard: nameOf(root), fid: fid, count: seen[fid] });
  }
  return { title: String(doc.title), total: total, withoutSent: withoutSent, byLayer: byLayer, duplicates: duplicates };
})());
