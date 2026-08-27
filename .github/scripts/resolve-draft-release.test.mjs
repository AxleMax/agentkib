import assert from "node:assert/strict";
import test from "node:test";

import { loadReleaseByTag, resolveDraftRelease } from "./resolve-draft-release.mjs";

const expected = {
  id: 42,
  tag_name: "v0.4.0",
  target_commitish: "release-sha",
  draft: true,
};

test("resolves a draft release immediately", async () => {
  const release = await resolveDraftRelease({
    load: async () => expected,
    tag: "v0.4.0",
    expectedSha: "release-sha",
    delays: [],
  });
  assert.equal(release.id, 42);
});

test("retries a temporarily invisible draft release", async () => {
  const responses = [undefined, undefined, expected];
  const waits = [];
  const release = await resolveDraftRelease({
    load: async () => responses.shift(),
    tag: "v0.4.0",
    expectedSha: "release-sha",
    delays: [10, 20],
    sleep: async (milliseconds) => waits.push(milliseconds),
  });
  assert.equal(release.id, 42);
  assert.deepEqual(waits, [10, 20]);
});

test("rejects mismatched, public, and invalid releases", async () => {
  for (const release of [
    { ...expected, tag_name: "v0.4.1" },
    { ...expected, target_commitish: "other-sha" },
    { ...expected, draft: false },
    { ...expected, id: "42" },
  ]) {
    await assert.rejects(
      resolveDraftRelease({
        load: async () => release,
        tag: "v0.4.0",
        expectedSha: "release-sha",
        delays: [],
      }),
    );
  }
});

test("times out after the bounded retry schedule", async () => {
  let attempts = 0;
  await assert.rejects(
    resolveDraftRelease({
      load: async () => {
        attempts += 1;
        return undefined;
      },
      tag: "v0.4.0",
      expectedSha: "release-sha",
      delays: [1, 2, 3],
      sleep: async () => undefined,
    }),
    /Timed out/,
  );
  assert.equal(attempts, 4);
});

test("treats GitHub 404 as not yet visible", async () => {
  const missing = await loadReleaseByTag({
    repository: "starroyhq/agentkib",
    tag: "v0.4.0",
    token: "test-token",
    request: async () => ({ status: 404, ok: false }),
  });
  assert.equal(missing, undefined);
});
