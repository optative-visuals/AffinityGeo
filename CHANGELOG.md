# Changelog

All notable changes to AffinityGeo are listed here.

## Unreleased

- A project can now hold several locations. Each is a box or a custom shape with corners you can add and remove.
- Edit locations over a street map (OpenFreeMap, with OpenStreetMap data) in the New project window and on the Area screen.
- Each location can fetch a margin of surroundings, from 0 to 1000 m.
- Each map belongs to one location.
- In Affinity, a map is masked to its location's shape. Tick **Show surrounding context** to add the surroundings, faded, as an editable group.
- Projects from 0.1.x open unchanged as one box location.

## 0.1.0 - 29 October 2026

First release.

- Search for a place, adjust the area on a preview map and fetch its data from OpenStreetMap.
- Import your own data from shapefile, GeoJSON, KML, GPX or CSV, and choose which kind of data each file provides.
- Choose a look from the presets and adjust the style.
- Add several "you are here" maps to a project by clicking where each goes, with a size and rotation for each.
- Send maps to artboards in open Affinity documents as real, editable shapes and layers. Hand edits made in Affinity are kept when a map is sent again.
- Save and reopen projects, with a recent-projects list.
- Windows installer with automatic update checks against GitHub Releases.
- First-run checklist, a built-in guide, and a status light showing whether Affinity is connected.
