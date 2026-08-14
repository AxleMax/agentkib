import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { get } from "node:https";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const version = "0.49.5";
const releases = {
  "aarch64-apple-darwin": {
    asset: `CodexBarCLI-v${version}-macos-arm64.tar.gz`,
    sha256: "bdc7469cb37db9354a51b0404e30ba00f12dd548dcdca10e50b283e7af1d370c",
  },
  "x86_64-apple-darwin": {
    asset: `CodexBarCLI-v${version}-macos-x86_64.tar.gz`,
    sha256: "d5006a70e131010cc6ec997633e8e897f106a645dbef363201f15675262ebca4",
  },
};

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const tauriDirectory = resolve(scriptDirectory, "../src-tauri");
const target = process.env.AGENTKIB_QUOTA_TARGET
  ?? process.env.CARGO_BUILD_TARGET
  ?? rustHostTriple();
const release = releases[target];

if (!release) {
  process.stdout.write(`AgentKib quota sidecar: ${target} is reserved but not bundled yet.\n`);
  process.exit(0);
}

const cacheRoot = process.env.XDG_CACHE_HOME
  ? resolve(process.env.XDG_CACHE_HOME, "agentkib/codexbar", version)
  : join(homedir(), ".cache/agentkib/codexbar", version);
const archive = join(cacheRoot, release.asset);
await mkdir(cacheRoot, { recursive: true });

if (!(await hasExpectedHash(archive, release.sha256))) {
  await rm(archive, { force: true });
  const temporary = `${archive}.download`;
  await rm(temporary, { force: true });
  await download(
    `https://github.com/steipete/CodexBar/releases/download/v${version}/${release.asset}`,
    temporary,
  );
  if (!(await hasExpectedHash(temporary, release.sha256))) {
    await rm(temporary, { force: true });
    throw new Error(`CodexBarCLI ${version} checksum mismatch`);
  }
  await rename(temporary, archive);
}

const extracted = await mkdtemp(join(tmpdir(), "agentkib-codexbar-"));
try {
  const result = spawnSync("tar", ["-xzf", archive, "-C", extracted], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("Failed to extract CodexBarCLI archive");

  const binaryDirectory = join(tauriDirectory, "binaries");
  const binary = join(binaryDirectory, `agentkib-quota-sidecar-${target}`);
  await mkdir(binaryDirectory, { recursive: true });
  await copyFile(join(extracted, "CodexBarCLI"), binary);
  await chmod(binary, 0o755);

  const resourcesDirectory = join(tauriDirectory, "resources");
  const resourceBundle = join(resourcesDirectory, "CodexBar_CodexBarCore.bundle");
  await mkdir(resourcesDirectory, { recursive: true });
  await rm(resourceBundle, { recursive: true, force: true });
  await cp(join(extracted, "CodexBar_CodexBarCore.bundle"), resourceBundle, { recursive: true });
  process.stdout.write(`AgentKib quota sidecar: prepared CodexBarCLI ${version} for ${target}.\n`);
} finally {
  await rm(extracted, { recursive: true, force: true });
}

function rustHostTriple() {
  const result = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("Unable to determine Rust host triple");
  const host = result.stdout.match(/^host:\s+(.+)$/m)?.[1]?.trim();
  if (!host) throw new Error("rustc did not report a host triple");
  return host;
}

async function hasExpectedHash(path, expected) {
  try {
    const digest = createHash("sha256").update(await readFile(path)).digest("hex");
    return digest === expected;
  } catch {
    return false;
  }
}

async function download(url, destination, redirects = 0) {
  if (redirects > 8) throw new Error("Too many redirects while downloading CodexBarCLI");
  await new Promise((resolveDownload, reject) => {
    const request = get(url, { headers: { "User-Agent": "AgentKib-build" } }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        download(new URL(response.headers.location, url).toString(), destination, redirects + 1)
          .then(resolveDownload, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`CodexBarCLI download failed with HTTP ${response.statusCode}`));
        return;
      }
      const output = createWriteStream(destination, { mode: 0o600 });
      response.pipe(output);
      output.on("finish", () => output.close(resolveDownload));
      output.on("error", reject);
    });
    request.on("error", reject);
  });
  await access(destination);
}
