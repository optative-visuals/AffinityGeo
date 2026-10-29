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
