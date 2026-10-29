# Releasing AffinityGeo

A release is built by GitHub, not on your computer. You push a version tag and GitHub Actions tests the code, builds the Windows installer and attaches it to a **draft** release.

## Steps

1. Bump the version in both `package.json` files (the root one and `apps/desktop/package.json`). They must match.
2. Commit the change.
3. Tag it: `git tag v0.1.0` (use your new version, with a leading `v`).
4. Push the tag: `git push --tags`.
5. Wait for the "Release" workflow to finish in the repo's Actions tab, then open the draft release on GitHub, check the installer is attached, and publish it.

If the tag and the version in `apps/desktop/package.json` differ, the workflow stops straight away with a message saying so. Fix the version, commit, then delete the tag and create it again:

```
git tag -d v0.1.0
git push origin :refs/tags/v0.1.0
git tag v0.1.0
git push origin v0.1.0
```

(Use your own version in place of `v0.1.0`.) If a draft release was already created for that tag, delete the draft on GitHub too, or the new run attaches to it.

## When do people get the update?

- The release must be **published**, not left as a draft. Drafts are invisible to the app.
- The repository must be **public**. While it is private, AffinityGeo cannot see new releases, so nobody is told about updates.
- The Releases link in the README (https://github.com/optative-visuals/AffinityGeo/releases) only works for visitors once a release is published. Until then they see nothing there.

Do the first public release only after you have decided to make the repository public.

## Before making the repo public

Checked on 29 October 2026: personal details (a private email, the local user folder, the computer's name and the project's folder path) were removed from the files, and the public history was restarted from a single clean commit. Before any future push, keep personal paths and emails out of committed files and don't commit Affinity `~lock~` files (they hold the computer's name; `.gitignore` excludes them).

## SmartScreen

The installer is unsigned, so Windows SmartScreen may warn people the first time they run it.
