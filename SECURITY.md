# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue. On the repository's Security tab, choose **Report a vulnerability** to open a private security advisory. I'll reply as soon as I can.

Please include the AffinityGeo version, what you did and what happened.

## What is in scope

- The local server AffinityGeo runs on `127.0.0.1:8790`, which the app and the Affinity scripts talk to.
- The updater, which checks GitHub Releases and installs new versions.
- The Windows installer.

AffinityGeo is a desktop tool for one person. The local server is meant to be reachable from the same computer only.

## Supported versions

Only the latest release gets fixes.
