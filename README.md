# AffinityGeo

## What it is
AffinityGeo makes wayfinding maps for Affinity. You pick a place, choose a look, and it draws a family of "you are here" maps onto artboards in your Affinity documents. Everything stays editable: real shapes, real layers, nothing flattened.

<!-- screenshot: the Maps screen -->

## Install
1. Download `AffinityGeo-Setup-<version>.exe` from the [Releases page](https://github.com/optative-visuals/AffinityGeo/releases) on GitHub and run it.
2. Windows may say "Windows protected your PC". Choose **More info**, then **Run anyway**. This happens because the app isn't signed yet.
3. The installer asks where to put AffinityGeo. Keep the default folder or choose another. "Only for me" (the default) never asks for admin rights. If you choose "Anyone who uses this computer" or a protected folder such as Program Files, Windows shows an admin (UAC) prompt, and such installs ask again at each update.

## First run
AffinityGeo shows a short checklist the first time. Three steps, once only:
1. In Affinity, open Settings > Scripting and allow `C:\AffinityGeo` under File System Access.
2. In AffinityGeo, choose **Copy Geo – Connect** (it's also in Settings). Paste it into a new script in Affinity's Script Editor and run it.
3. The light at the bottom of AffinityGeo turns green.

## A 2-minute quickstart
1. Choose **New project**.
2. Search for a place.
3. Adjust the box so it covers the area you want.
4. Choose a look.
5. Choose **Create and fetch data**.
6. Open **Maps** and add three maps by clicking where each one goes.
7. Choose a document for them.
8. Choose **Send all changed**.

## How your edits are kept
Change something in AffinityGeo and only that thing changes in Affinity. If you edit a shape by hand in Affinity, such as its colour or outline, AffinityGeo leaves that property alone from then on. Your own extra objects are never touched. To hand control back, use **Reset hand edits** on a map.

## Updates
AffinityGeo checks the [Releases page](https://github.com/optative-visuals/AffinityGeo/releases) on GitHub for a new version shortly after it starts, then every six hours. It downloads quietly and asks before restarting ("Restart now" or "Later"). Later installs the update next time you quit. If AffinityGeo says the scripts were updated, run Geo – Connect again in Affinity.

## Known limits
- Windows only.
- Fetching a large area takes 30 to 60 seconds.
- Not yet: labels, routes, insets, legends, scale bar.
- Maps only draw into documents that are open in Affinity.
- The installer isn't signed yet.
- Uninstalling removes the app but leaves `C:\AffinityGeo` (your Geo – Connect scripts and anything you saved there). You can delete that folder yourself.

## Development
You need Node 24 or later (see `engines` in `package.json`) and Windows. The Affinity side needs Affinity 3 with scripting turned on.

- `npm ci` (or `npm install`)
- `node node_modules/electron/install.js` if the Electron download didn't happen
- `npm run app` to run it
- `npm test` to run the tests
- `npm run lint` and `npm run typecheck` to check the code
- `npm run dist` to build the installer. If it fails with "copyfile elevate.exe UNKNOWN", set `ELECTRON_BUILDER_CACHE=C:\ebcache` first (a known local cache quirk).

Things that may look odd:
- The desktop app's runtime libraries (React and so on) are `devDependencies` in `apps/desktop/package.json` on purpose: the build bundles them into the app, so the installer doesn't need them as separate dependencies.
- `typescript` in the root `package.json` is TypeScript 6's JavaScript API, which typescript-eslint needs. TypeScript 7 is installed as `typescript-7`, and the `typecheck` scripts run it directly, because typescript-eslint doesn't support TypeScript 7 yet.
- `apps/desktop/build/` holds generated icons and installer images. `npm run icons` makes them and they are committed on purpose, so release builds carry the app icon.

On Node below 24.15, the tests print a jsdom engine warning. It is harmless. Releases are described in `docs/releasing.md`. To contribute, see `CONTRIBUTING.md`.

## Licence and credits
- GPL-3.0-or-later.
- Map data © OpenStreetMap contributors (ODbL).
- Place search by Nominatim.
- Portions adapted from CavalryGeo (GPL).
- By Optative.
