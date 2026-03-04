# Release Process

## How It Works

Every push to `main` triggers a GitHub Actions workflow that builds the Windows installer on `windows-latest`. The `.exe` and `latest.yml` are saved as build artifacts.

To publish a release, include `[release]` anywhere in your commit message:

```
Fix workflow startup crash [release]
```

This tells the workflow to also:
1. Read the version from `package.json`
2. Create a git tag `v{version}`
3. Create a GitHub Release with auto-generated release notes
4. Attach the `.exe` installer and `latest.yml` to the release

Without `[release]` in the message, the workflow just builds — no release is created.

## Bumping the Version

Before a release commit, update the `version` field in `package.json`. If you don't, the workflow will try to create a release with the same tag as a previous one, which will either fail or overwrite it.

```json
"version": "2.1.0"
```

Use semver: bump the patch for fixes (`2.0.1`), minor for features (`2.1.0`), major for breaking changes (`3.0.0`).

## How Auto-Update Reaches Users

The Electron app calls `autoUpdater.checkForUpdatesAndNotify()` on every launch. This:
1. Hits the GitHub Releases API for `AshOfCreativity/ciscript-watcher`
2. Downloads `latest.yml` from the most recent release
3. Compares the version in `latest.yml` against the running app's version
4. If newer: downloads the `.exe` in the background, shows a notification
5. Installs on next app restart

## Security Considerations

### Commit message trigger
Anyone with push access to `main` can trigger a release by including `[release]` in a commit message. If you accept PRs from external contributors, review carefully — a merged PR with `[release]` in its squash commit message will publish a release. Limit push access to trusted collaborators.

### GITHUB_TOKEN permissions
The workflow uses `GITHUB_TOKEN` with `contents: write`. This is scoped to the repository and expires after the workflow run. It cannot access other repos or secrets. This is the minimum permission needed to create releases.

### Code signing
The `.exe` is not code-signed. Windows will show a SmartScreen warning on first install ("Windows protected your PC"). Users must click "More info" → "Run anyway." Code signing requires a certificate ($200-400/year) and is not set up. This also means a compromised build could produce a malicious `.exe` without detection — there's no signature to verify.

### Supply chain
The workflow installs dependencies via `npm install` on every build. A compromised npm package could inject code into the installer. Mitigation: use `package-lock.json` (already present) to pin exact versions. Consider running `npm audit` as a build step.

### Update channel integrity
`electron-updater` verifies downloads using the sha512 hash in `latest.yml`. If an attacker modifies the `.exe` on the release without updating `latest.yml`, the update will fail validation. However, if an attacker has write access to the repo (and therefore can trigger builds), they could produce a matching pair. Repo access control is the primary defense.

### No update pinning
Users cannot opt out of updates or pin a version. `checkForUpdatesAndNotify()` runs unconditionally on every launch. A bad release will be pushed to all users. If this is a concern, consider adding a config toggle for auto-updates.
