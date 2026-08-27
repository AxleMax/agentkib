import { pathToFileURL } from "node:url";

const retryDelaysMs = [1_000, 2_000, 4_000, 8_000, 12_000, 18_000];

function validateDraftRelease(release, { tag, expectedSha }) {
  if (release.tag_name !== tag) {
    throw new Error(`Release tag ${release.tag_name ?? "<missing>"} does not match ${tag}`);
  }
  if (release.target_commitish !== expectedSha) {
    throw new Error(
      `Release ${tag} targets ${release.target_commitish ?? "<missing>"}, expected ${expectedSha}`,
    );
  }
  if (release.draft !== true) {
    throw new Error(`Release ${tag} is already public; refusing to overwrite it`);
  }
  if (!Number.isInteger(release.id) || release.id <= 0) {
    throw new Error(`Release ${tag} does not have a valid numeric ID`);
  }
  return release;
}

export async function resolveDraftRelease({
  load,
  tag,
  expectedSha,
  delays = retryDelaysMs,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    const release = await load();
    if (release) return validateDraftRelease(release, { tag, expectedSha });
    if (attempt < delays.length) await sleep(delays[attempt]);
  }
  throw new Error(`Timed out waiting for draft release ${tag}`);
}

export async function loadReleaseByTag({ repository, tag, token, request = fetch }) {
  const response = await request(
    `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "agentkib-release-workflow",
      },
    },
  );
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`GitHub release lookup failed with HTTP ${response.status}`);
  }
  return response.json();
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const tag = process.env.RELEASE_TAG;
  const expectedSha = process.env.RELEASE_SHA;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!repository || !tag || !expectedSha || !token) {
    throw new Error("GITHUB_REPOSITORY, RELEASE_TAG, RELEASE_SHA, and GH_TOKEN are required");
  }

  const load = () => loadReleaseByTag({ repository, tag, token });
  const release = process.argv.includes("--wait")
    ? await resolveDraftRelease({ load, tag, expectedSha })
    : await load();
  if (!release) return;
  process.stdout.write(`${JSON.stringify(validateDraftRelease(release, { tag, expectedSha }))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
