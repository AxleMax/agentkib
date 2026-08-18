# Desktop package workflow

AgentKib desktop packages are generated only by the manually triggered
`Desktop Package Artifacts` GitHub Actions workflow. Pull requests and pushes
run platform checks, but they do not create installers.

## Build packages

1. Open **Actions** in the GitHub repository.
2. Select **Desktop Package Artifacts**.
3. Choose **Run workflow** and select the branch to build. To build a tag, run
   `gh workflow run release-desktop.yml --ref <tag>` instead.
4. Wait for the preflight and every platform job to pass.
5. Download the artifact for the target platform from the completed run.

The workflow locks every job to the selected revision's commit. Before
packaging, it verifies that the versions in the Tauri configuration, desktop
package, and Cargo workspace match, then runs the full Rust and frontend check
suite.

## Artifacts

- `agentkib-desktop-macos-arm64`: zipped `.app`, DMG, and checksums.
- `agentkib-desktop-macos-x64`: zipped `.app`, DMG, and checksums.
- `agentkib-desktop-windows-x64`: NSIS installer and checksum.
- `agentkib-desktop-windows-arm64-preview`: preview NSIS installer and checksum.
- `agentkib-desktop-linux-ubuntu-x64`: Deb, AppImage, and checksums.
- `agentkib-desktop-linux-ubuntu-arm64-preview`: preview Deb, AppImage, and checksums.
- `agentkib-desktop-linux-fedora-x64`: RPM and checksum.

Each checksum file is named after its package with the `.sha256` suffix. Verify
the downloaded package before installing it, for example:

```bash
shasum -a 256 -c AgentKib_0.1.0_macos-arm64.dmg.sha256
```

On Linux, use `sha256sum -c`. On Windows, compare the value in the checksum
file with `Get-FileHash <installer> -Algorithm SHA256`.

## Preview limitations

These workflow artifacts are unsigned development previews. They are not
attached to a GitHub Release and do not include macOS notarization, Windows
code signing, MSI packages, a macOS universal binary, or automatic updates.
macOS Gatekeeper and Windows SmartScreen may therefore display warnings.

Before sharing a build, confirm that all platform jobs passed and test the
downloaded package on the intended operating system. ARM64 packages remain
preview-only until they have been verified on representative hardware.
