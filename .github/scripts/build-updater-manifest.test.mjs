import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildUpdaterManifest } from "./build-updater-manifest.mjs";

const suffixes = [
  "macos-arm64.app.tar.gz",
  "macos-x64.app.tar.gz",
  "linux-arm64-preview.AppImage",
  "linux-x64.AppImage",
  "windows-arm64-preview.exe",
  "windows-x64.exe",
];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "agentkib-updater-"));
  for (const suffix of suffixes) {
    const artifact = join(directory, `AgentKib_0.3.0_${suffix}`);
    writeFileSync(artifact, "bundle");
    writeFileSync(`${artifact}.sig`, `signature-${suffix}\n`);
  }
  return directory;
}

test("builds a complete static updater manifest", () => {
  const manifest = buildUpdaterManifest({
    assetsDir: fixture(),
    repository: "starroyhq/agentkib",
    tag: "v0.3.0",
    version: "0.3.0",
    publishedAt: "2026-08-26T00:00:00Z",
    notes: "Updater release notes",
  });

  assert.equal(manifest.version, "0.3.0");
  assert.equal(manifest.notes, "Updater release notes");
  assert.deepEqual(Object.keys(manifest.platforms), [
    "darwin-aarch64",
    "darwin-x86_64",
    "linux-aarch64",
    "linux-x86_64",
    "windows-aarch64",
    "windows-x86_64",
  ]);
  assert.match(manifest.platforms["darwin-aarch64"].url, /v0.3.0\/AgentKib_0.3.0/);
});

test("rejects missing signatures and mismatched tags", () => {
  const assetsDir = fixture();
  writeFileSync(join(assetsDir, "AgentKib_0.3.0_linux-x64.AppImage.sig"), "");
  assert.throws(
    () =>
      buildUpdaterManifest({
        assetsDir,
        repository: "starroyhq/agentkib",
        tag: "v0.3.0",
        version: "0.3.0",
        publishedAt: "2026-08-26T00:00:00Z",
        notes: "Release notes",
      }),
    /signature is empty/,
  );
  assert.throws(
    () =>
      buildUpdaterManifest({
        assetsDir: fixture(),
        repository: "starroyhq/agentkib",
        tag: "v0.4.0",
        version: "0.3.0",
        publishedAt: "2026-08-26T00:00:00Z",
        notes: "Release notes",
      }),
    /does not match/,
  );
});
