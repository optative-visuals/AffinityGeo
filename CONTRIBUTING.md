# Contributing to AffinityGeo

Thanks for taking an interest. AffinityGeo is small and looked after by one person, so please keep changes focused.

## Setup

You need Windows, Node 24 or later and Git. To try the Affinity side you also need Affinity 3 with scripting turned on.

```
npm ci
npm run app
```

`npm run app` builds the desktop app and opens it.

## Before you open a pull request

Please make sure all of these pass:

```
npm test
npm run lint
npm run typecheck
```

GitHub runs the same checks on every pull request, plus `npm run build:app`. Keep the tests green: add or update a test with any change in behaviour.

## Testing with Claude

`apps/mcp` is a small MCP server that lets Claude Code start a test copy of AffinityGeo, look at its window, click and type in it, and read its state. It is developer tooling only and is never part of the installer.

Claude Code finds it through `.mcp.json` (server name `affinitygeo`) and asks you to approve it once. Two rules:

- Close your own AffinityGeo window first. The test copy uses the same port (8790) and refuses to start while it is taken. It runs in a throwaway profile, so your recent projects and settings are never touched.
- To test against Affinity as well, open Affinity, run Geo – Connect and close the Script Editor. Claude reads the document back through Affinity's own MCP server.

| Tools | What they do |
|---|---|
| `app_launch`, `app_quit`, `app_status`, `app_logs` | Start and stop the test copy, and report on it. `fixtures: true` uses recorded Hyde Park data instead of the internet. |
| `ui_snapshot`, `ui_screenshot` | Read the window as a list of controls, or as a picture. |
| `ui_click`, `ui_type`, `ui_press`, `ui_drag`, `ui_wait_for` | Use the window. |
| `api_request` | Call the app's local API directly. |
| `dialog_answer` | Answer the next Open, Save or message box in advance (nobody is there to click it). |
| `affinity_check` | Ready-made scripts that read an Affinity document back. |

The server's own tests run with `npm test`. The tests that really open the app are skipped unless you ask for them:

```
GEO_E2E=1 npx vitest run apps/mcp/test/e2e.test.ts
```

## Proposing a change

1. Open an issue first for anything bigger than a small fix, so we can agree the approach.
2. Fork the repository and make your change on a branch.
3. Open a pull request against `main` and describe what changed and why.

## Style

- Follow `.editorconfig` (UTF-8, LF line endings, 2 spaces).
- Use UK English in the app's text.
- The product name is always written AffinityGeo.
- Please don't include personal file paths or other private details in code, tests or issues.

By contributing you agree that your work is licensed under GPL-3.0-or-later, like the rest of the project.
