# Desktop release workflow

AgentKib desktop releases are built, verified, and published by the
`Desktop Package Artifacts` GitHub Actions workflow. Pull requests and normal
branch pushes run platform checks but do not publish installers.

## Publish a release

1. Update the desktop version in the workspace `Cargo.toml`,
   `apps/desktop/package.json`, and
   `apps/desktop/src-tauri/tauri.conf.json`.
2. Merge the version change into `main` and make sure the required checks pass.
3. Create an annotated version tag on that `main` commit and push only the tag:

   ```bash
   git switch main
   git pull --ff-only origin main
   git tag -a v0.1.0 -m "AgentKib v0.1.0"
   git push origin v0.1.0
   ```

4. Wait for every job in **Desktop Package Artifacts** to pass. The workflow
   creates a draft GitHub Release only after all platform builds complete. It
   verifies the complete asset manifest, SHA-256 checksums, updater signatures,
   and `latest.json`, uploads the files, checks their remote names and sizes,
   and then publishes the release.

Do not create an empty GitHub Release before pushing the tag. Stable SemVer
tags such as `v0.1.0` become the latest release. Tags containing a prerelease
suffix, such as `v0.2.0-beta.1`, are published as prereleases.

The workflow refuses to publish when the tag does not exactly match the
desktop version, the three version sources differ, or the tagged commit is not
contained in `origin/main`. Every build job checks out the same resolved commit.

## Retry a failed release

If a run fails because of a transient runner, network, repository setting, or
workflow problem after creating the draft, fix the underlying problem without
publishing the incomplete draft, then run the workflow against the existing
tag:

```bash
gh workflow run release-desktop.yml --ref main -f release_tag=vX.Y.Z
```

The retry rebuilds every platform, resumes an existing draft, and replaces
same-named draft assets. It refuses to overwrite a release that is already
public. A product-code fix requires a new version and tag rather than moving an
existing tag. Workflow artifacts remain available for diagnosing failed builds.

## Build artifacts without publishing

To create packages for a branch without creating a GitHub Release, open
**Actions**, select **Desktop Package Artifacts**, choose **Run workflow**, pick
the branch, and leave `release_tag` empty.

The run produces these downloadable workflow artifacts:

- `agentkib-desktop-macos-arm64`: zipped `.app`, DMG, and checksums.
- `agentkib-desktop-macos-x64`: zipped `.app`, DMG, and checksums.
- `agentkib-desktop-windows-x64`: NSIS installer and checksum.
- `agentkib-desktop-windows-arm64-preview`: preview NSIS installer and checksum.
- `agentkib-desktop-linux-ubuntu-x64`: Deb, AppImage, and checksums.
- `agentkib-desktop-linux-ubuntu-arm64-preview`: preview Deb, AppImage, and checksums.
- `agentkib-desktop-linux-fedora-x64`: RPM and checksum.

Each checksum file is named after its package with the `.sha256` suffix. Verify
a downloaded package before installing it, for example:

```bash
shasum -a 256 -c AgentKib_0.1.0_macos-arm64.dmg.sha256
```

On Linux, use `sha256sum -c`. On Windows, compare the value in the checksum
file with `Get-FileHash <installer> -Algorithm SHA256`.

## Updater signing

Published tags require `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in GitHub Actions Secrets. The corresponding
public key is compiled into the desktop application. Do not rotate this key as
part of a normal release: clients that contain the old public key cannot install
updates signed only by a replacement key.

The encrypted private-key backup is maintained outside the repository. Losing
both that backup and the GitHub Secret breaks the update path for already
installed clients. Tauri updater signatures verify update origin and integrity;
they do not replace Apple notarization or Windows Authenticode signing.

## Preview limitations

Release packages are unsigned development previews. They do not include macOS
notarization, Windows code signing, MSI packages, or a macOS universal binary.
macOS Gatekeeper and Windows SmartScreen may therefore display warnings.

v0.3.1 is the first updater-capable release. Clients older than v0.3.1 require
one manual upgrade; later stable releases can be installed in-app on macOS,
Windows, and Linux AppImage. DEB and RPM installations check for updates but
continue through the GitHub Release page so their system package state is not
modified behind the package manager.

After verifying the downloaded DMG against its `.sha256` file and copying
AgentKib into Applications, macOS users must currently remove the quarantine
attributes before opening the app:

```bash
xattr -cr /Applications/AgentKib.app
```

This command bypasses Gatekeeper's quarantine check. It must only be used for
an AgentKib package downloaded from the official GitHub Release whose checksum
has been verified.

ARM64 Windows and Linux packages remain preview-only until they have been
verified on representative hardware.
