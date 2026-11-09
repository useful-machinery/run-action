import assert from "node:assert/strict";
import test from "node:test";

import {
  generateReleaseEvidence,
  REQUIRED_SOURCE_ANCESTOR,
  serializeReleaseEvidence,
  TARGETS,
  type ReleaseEvidenceDependencies,
} from "../scripts/release-evidence.ts";
import { archiveBytes, sha256, type TarMutation } from "./fake-release.ts";

const TAG = "v9.9.9";
const VERSION = "9.9.9";
const API = "https://api.github.com/repos/useful-machinery/um";
const DOWNLOADS = `https://github.com/useful-machinery/um/releases/download/${TAG}`;
const RELEASE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SOURCE_REVISION = "fedcba9876543210fedcba9876543210fedcba98";

interface Asset {
  id: number;
  name: string;
  size: number;
  digest: string;
  browser_download_url: string;
}

interface FakeRelease {
  release: {
    id: number;
    html_url: string;
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    assets: Asset[];
  };
  commit: { sha: string; commit: { message: string } };
  downloads: Map<string, Buffer>;
  expected: unknown;
}

function asset(id: number, name: string, bytes: Buffer): Asset {
  return {
    id,
    name,
    size: bytes.length,
    digest: `sha256:${sha256(bytes)}`,
    browser_download_url: `${DOWNLOADS}/${name}`,
  };
}

// A published release whose assets, checksum list, release document and tag
// commit all agree; `mutation` breaks the archive layout of one target.
async function fakeRelease(mutation?: {
  target: (typeof TARGETS)[number];
  tar: TarMutation;
}): Promise<FakeRelease> {
  const downloads = new Map<string, Buffer>();
  const assets: Asset[] = [];
  const archives: Record<string, unknown> = {};
  const lines: string[] = [];
  let id = 10;
  for (const target of TARGETS) {
    const root = `um-${VERSION}-${target}`;
    const name = `${root}.tar.gz`;
    const built = await archiveBytes(
      root,
      mutation?.target === target ? mutation.tar : undefined,
    );
    const archive = asset(++id, name, built.bytes);
    assets.push(archive);
    downloads.set(archive.browser_download_url, built.bytes);
    lines.push(`${sha256(built.bytes)}  ${name}`);
    archives[target] = {
      id: archive.id,
      name,
      size: built.bytes.length,
      sha256: sha256(built.bytes),
      url: archive.browser_download_url,
      rootDirectory: root,
      inventory: built.inventory,
    };
  }
  const sums = Buffer.from(`${lines.join("\n")}\n`);
  const checksum = asset(++id, "SHA256SUMS", sums);
  assets.unshift(checksum);
  downloads.set(checksum.browser_download_url, sums);
  return {
    release: {
      id: 1,
      html_url: `https://github.com/useful-machinery/um/releases/tag/${TAG}`,
      tag_name: TAG,
      draft: false,
      prerelease: false,
      assets,
    },
    commit: {
      sha: RELEASE_COMMIT,
      commit: {
        message: `Mirror CLI candidate\n\nSource-Revision: ${SOURCE_REVISION}\nCandidate-Plan-SHA256: ${"c".repeat(64)}\n`,
      },
    },
    downloads,
    expected: {
      schemaVersion: 1,
      repository: "useful-machinery/um",
      releaseUrl: `https://github.com/useful-machinery/um/releases/tag/${TAG}`,
      tag: TAG,
      releaseId: 1,
      releaseCommit: RELEASE_COMMIT,
      sourceRevision: SOURCE_REVISION,
      requiredSourceAncestor: "7215869ca26439d305c097af1dca50ebb8066419",
      version: VERSION,
      buildIdentity: RELEASE_COMMIT,
      checksumAsset: {
        id: checksum.id,
        name: "SHA256SUMS",
        size: sums.length,
        sha256: sha256(sums),
        url: checksum.browser_download_url,
      },
      archives,
    },
  };
}

// Replaces one download's bytes and keeps its asset's size and digest
// consistent with them, so only the property under test disagrees.
function replaceDownload(fake: FakeRelease, name: string, bytes: Buffer): void {
  const target = fake.release.assets.find((entry) => entry.name === name);
  assert.ok(target);
  target.size = bytes.length;
  target.digest = `sha256:${sha256(bytes)}`;
  fake.downloads.set(target.browser_download_url, bytes);
}

interface Observations {
  requests: { url: string; headers: Record<string, string> }[];
  ancestry: [string, string][];
}

function dependencies(
  fake: FakeRelease,
  observations: Observations,
  ancestor = true,
): ReleaseEvidenceDependencies {
  const responses = new Map<string, () => Response>([
    [`${API}/releases/tags/${TAG}`, () => Response.json(fake.release)],
    [`${API}/commits/${TAG}`, () => Response.json(fake.commit)],
  ]);
  for (const [url, bytes] of fake.downloads) {
    responses.set(url, () => new Response(new Uint8Array(bytes)));
  }
  return {
    fetch: async (url, headers) => {
      observations.requests.push({ url, headers });
      const respond = responses.get(url);
      return respond ? respond() : new Response(null, { status: 404 });
    },
    isAncestor: async (ancestorRevision, descendant) => {
      observations.ancestry.push([ancestorRevision, descendant]);
      return ancestor;
    },
  };
}

function observe(): Observations {
  return { requests: [], ancestry: [] };
}

// REQ-RUNACTION-80, REQ-ONBOARD-4
// INV-EMBED-21
test("the generator records a verified stable release in the committed key order", async () => {
  const fake = await fakeRelease();
  const observations = observe();
  const evidence = await generateReleaseEvidence(
    TAG,
    dependencies(fake, observations),
  );

  assert.deepEqual(evidence, fake.expected);
  assert.deepEqual(Object.keys(evidence), [
    "schemaVersion",
    "repository",
    "releaseUrl",
    "tag",
    "releaseId",
    "releaseCommit",
    "sourceRevision",
    "requiredSourceAncestor",
    "version",
    "buildIdentity",
    "checksumAsset",
    "archives",
  ]);
  assert.deepEqual(Object.keys(evidence.checksumAsset), [
    "id",
    "name",
    "size",
    "sha256",
    "url",
  ]);
  assert.deepEqual(Object.keys(evidence.archives), [...TARGETS]);
  for (const archive of Object.values(evidence.archives)) {
    assert.deepEqual(Object.keys(archive), [
      "id",
      "name",
      "size",
      "sha256",
      "url",
      "rootDirectory",
      "inventory",
    ]);
  }
  assert.deepEqual(observations.ancestry, [
    [REQUIRED_SOURCE_ANCESTOR, SOURCE_REVISION],
  ]);
  assert.equal(
    serializeReleaseEvidence(evidence),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
});

// REQ-RUNACTION-80
test("a GitHub token authorizes the API reads and never the downloads", async () => {
  const fake = await fakeRelease();
  const observations = observe();
  const previous = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "fixture-token";
  try {
    await generateReleaseEvidence(TAG, dependencies(fake, observations));
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
  }
  for (const { url, headers } of observations.requests) {
    assert.equal(
      headers.Authorization,
      url.startsWith(API) ? "Bearer fixture-token" : undefined,
      url,
    );
  }
  assert.equal(
    observations.requests.filter(({ url }) => !url.startsWith(API)).length,
    4,
  );
});

// REQ-RUNACTION-80
for (const field of ["prerelease", "draft"] as const) {
  test(`a ${field} release is refused before any download`, async () => {
    const fake = await fakeRelease();
    fake.release[field] = true;
    const observations = observe();
    await assert.rejects(
      generateReleaseEvidence(TAG, dependencies(fake, observations)),
      { message: new RegExp(`is a ${field}`, "u") },
    );
    assert.deepEqual(
      observations.requests.filter(({ url }) => !url.startsWith(API)),
      [],
    );
  });
}

// REQ-RUNACTION-80
test("an asset whose bytes differ from its recorded digest is refused", async () => {
  const fake = await fakeRelease();
  const archive = fake.release.assets[1]!;
  archive.digest = `sha256:${sha256(Buffer.from("other"))}`;
  await assert.rejects(
    generateReleaseEvidence(TAG, dependencies(fake, observe())),
    { message: new RegExp(`${archive.name} .*digest`, "u") },
  );
});

// REQ-RUNACTION-80
test("an archive that differs from its SHA256SUMS line is refused", async () => {
  const fake = await fakeRelease();
  const sums = fake.downloads.get(`${DOWNLOADS}/SHA256SUMS`)!.toString();
  const name = `um-${VERSION}-${TARGETS[2]}.tar.gz`;
  const changed = sums.replace(
    /^[0-9a-f]{64}(?=  um-9\.9\.9-aarch64-apple-darwin)/mu,
    "0".repeat(64),
  );
  assert.notEqual(changed, sums);
  replaceDownload(fake, "SHA256SUMS", Buffer.from(changed));
  await assert.rejects(
    generateReleaseEvidence(TAG, dependencies(fake, observe())),
    { message: new RegExp(`${name} .*SHA256SUMS`, "u") },
  );
});

// REQ-RUNACTION-80
test("an asset whose size differs from its recorded size is refused", async () => {
  const fake = await fakeRelease();
  const archive = fake.release.assets[2]!;
  archive.size += 1;
  await assert.rejects(
    generateReleaseEvidence(TAG, dependencies(fake, observe())),
    { message: new RegExp(`${archive.name} .*size`, "u") },
  );
});

// REQ-RUNACTION-80
test("a release with an extra or a missing asset is refused", async () => {
  const extra = await fakeRelease();
  extra.release.assets.push(
    asset(99, "notes.txt", Buffer.from("release notes\n")),
  );
  await assert.rejects(
    generateReleaseEvidence(TAG, dependencies(extra, observe())),
    { message: /unexpected asset notes\.txt/u },
  );

  const missing = await fakeRelease();
  const name = `um-${VERSION}-${TARGETS[1]}.tar.gz`;
  missing.release.assets = missing.release.assets.filter(
    (entry) => entry.name !== name,
  );
  await assert.rejects(
    generateReleaseEvidence(TAG, dependencies(missing, observe())),
    { message: new RegExp(`missing asset ${name}`, "u") },
  );
});

// REQ-RUNACTION-80
for (const tar of ["inventory", "mode"] as const) {
  test(`an archive with a ${tar} change to the canonical layout is refused`, async () => {
    const target = TARGETS[1];
    const fake = await fakeRelease({ target, tar });
    await assert.rejects(
      generateReleaseEvidence(TAG, dependencies(fake, observe())),
      {
        message: new RegExp(`um-${VERSION}-${target}\\.tar\\.gz .*layout`, "u"),
      },
    );
  });
}

// REQ-RUNACTION-80
test("a release commit without exactly one Source-Revision trailer is refused", async () => {
  const none = await fakeRelease();
  none.commit.commit.message = "Mirror CLI candidate\n";
  await assert.rejects(
    generateReleaseEvidence(TAG, dependencies(none, observe())),
    { message: /no Source-Revision trailer/u },
  );

  const two = await fakeRelease();
  two.commit.commit.message += `Source-Revision: ${"1".repeat(40)}\n`;
  await assert.rejects(
    generateReleaseEvidence(TAG, dependencies(two, observe())),
    { message: /2 Source-Revision trailers/u },
  );
});

// REQ-RUNACTION-80
// INV-EMBED-21
test("a source revision that does not descend from the required ancestor is refused", async () => {
  const fake = await fakeRelease();
  await assert.rejects(
    generateReleaseEvidence(TAG, dependencies(fake, observe(), false)),
    {
      message: new RegExp(
        `${SOURCE_REVISION} does not descend from ${REQUIRED_SOURCE_ANCESTOR}`,
        "u",
      ),
    },
  );
});
