#!/usr/bin/env node

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const platforms = [
  ["darwin-aarch64", "macos-arm64.app.tar.gz"],
  ["darwin-x86_64", "macos-x64.app.tar.gz"],
  ["linux-aarch64", "linux-arm64-preview.AppImage"],
  ["linux-x86_64", "linux-x64.AppImage"],
  ["windows-aarch64", "windows-arm64-preview.exe"],
  ["windows-x86_64", "windows-x64.exe"],
];

function requiredText(path) {
  const value = readFileSync(path, "utf8").trim();
  if (!value) throw new Error(`Updater signature is empty: ${basename(path)}`);
  return value;
}

function releaseAssetUrl(repository, tag, filename) {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(filename)}`;
}

export function buildUpdaterManifest({ assetsDir, repository, tag, version, publishedAt, notes }) {
  if (tag !== `v${version}`) {
    throw new Error(`Updater tag ${tag} does not match version ${version}`);
  }
  if (!/^[-\w.]+\/[-\w.]+$/.test(repository)) {
    throw new Error(`Invalid GitHub repository: ${repository}`);
  }
  if (Number.isNaN(Date.parse(publishedAt))) {
    throw new Error(`Invalid updater publication date: ${publishedAt}`);
  }

  const prefix = `AgentKib_${version}_`;
  const targets = Object.fromEntries(
    platforms.map(([platform, suffix]) => {
      const filename = `${prefix}${suffix}`;
      const artifact = join(assetsDir, filename);
      const signature = `${artifact}.sig`;
      if (!statSync(artifact).isFile() || statSync(artifact).size === 0) {
        throw new Error(`Updater artifact is empty: ${filename}`);
      }
      return [
        platform,
        {
          signature: requiredText(signature),
          url: releaseAssetUrl(repository, tag, filename),
        },
      ];
    }),
  );

  return {
    version,
    notes: notes?.trim() || `AgentKib ${tag}`,
    pub_date: new Date(publishedAt).toISOString(),
    platforms: targets,
  };
}

function main(args) {
  const [assetsDir, repository, tag, version, publishedAt, notesPath] = args;
  if (!assetsDir || !repository || !tag || !version || !publishedAt || !notesPath) {
    throw new Error(
      "Usage: build-updater-manifest.mjs <assets-dir> <owner/repo> <tag> <version> <published-at> <notes-file>",
    );
  }
  const manifest = buildUpdaterManifest({
    assetsDir,
    repository,
    tag,
    version,
    publishedAt,
    notes: readFileSync(notesPath, "utf8"),
  });
  writeFileSync(join(assetsDir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
