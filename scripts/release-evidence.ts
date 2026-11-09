import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { isDeepStrictEqual, promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import * as tar from "tar-stream";

import type { ReleaseEvidence } from "../src/release.ts";

export const REPOSITORY = "useful-machinery/um";
export const REQUIRED_SOURCE_ANCESTOR =
  "7215869ca26439d305c097af1dca50ebb8066419";
export const TARGETS = [
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "aarch64-apple-darwin",
] as const;

type Target = (typeof TARGETS)[number];
type ArchiveRecord = ReleaseEvidence["archives"][Target];
type InventoryEntry = ArchiveRecord["inventory"][number];

export interface ReleaseEvidenceDependencies {
  readonly fetch: (
    url: string,
    headers: Record<string, string>,
  ) => Promise<Response>;
  readonly isAncestor: (
    ancestor: string,
    descendant: string,
  ) => Promise<boolean>;
}

const API = `https://api.github.com/repos/${REPOSITORY}`;
const RELEASE_PAGE = `https://github.com/${REPOSITORY}/releases`;
const CHECKSUM_ASSET = "SHA256SUMS";

interface ReleaseAsset {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly digest: string;
  readonly url: string;
}

interface VerifiedAsset {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly url: string;
  readonly bytes: Buffer;
}

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "useful-machinery-run-action-release-evidence",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function fetchOk(
  dependencies: ReleaseEvidenceDependencies,
  url: string,
  headers: Record<string, string>,
): Promise<Response> {
  const response = await dependencies.fetch(url, headers);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field<T>(
  document: Record<string, unknown>,
  key: string,
  check: (value: unknown) => value is T,
  context: string,
): T {
  const value = document[key];
  if (!check(value)) throw new Error(`${context} has no valid ${key}`);
  return value;
}

const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean =>
  typeof value === "boolean";
const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function releaseAssets(
  document: Record<string, unknown>,
  tag: string,
  version: string,
): Map<string, ReleaseAsset> {
  const listed = document.assets;
  if (!Array.isArray(listed)) throw new Error(`release ${tag} has no assets`);
  const expected = [
    CHECKSUM_ASSET,
    ...TARGETS.map((target) => `um-${version}-${target}.tar.gz`),
  ];
  const assets = new Map<string, ReleaseAsset>();
  for (const value of listed) {
    if (!isRecord(value))
      throw new Error(`release ${tag} has a malformed asset`);
    const name = field(value, "name", isString, `release ${tag} asset`);
    const context = `release ${tag} asset ${name}`;
    if (!expected.includes(name)) {
      throw new Error(`release ${tag} has unexpected asset ${name}`);
    }
    if (assets.has(name)) {
      throw new Error(`release ${tag} lists asset ${name} twice`);
    }
    const url = field(value, "browser_download_url", isString, context);
    if (url !== `${RELEASE_PAGE}/download/${tag}/${name}`) {
      throw new Error(`${context} has download URL ${url}`);
    }
    assets.set(name, {
      id: field(value, "id", isCount, context),
      name,
      size: field(value, "size", isCount, context),
      digest: field(value, "digest", isString, context),
      url,
    });
  }
  for (const name of expected) {
    if (!assets.has(name)) {
      throw new Error(`release ${tag} is missing asset ${name}`);
    }
  }
  return assets;
}

async function downloadVerified(
  dependencies: ReleaseEvidenceDependencies,
  asset: ReleaseAsset,
): Promise<VerifiedAsset> {
  if (!/^sha256:[0-9a-f]{64}$/u.test(asset.digest)) {
    throw new Error(`${asset.name} has malformed digest ${asset.digest}`);
  }
  const response = await fetchOk(dependencies, asset.url, {});
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== asset.size) {
    throw new Error(
      `${asset.name} is ${bytes.length} bytes but the release asset size is ${asset.size}`,
    );
  }
  const digest = sha256(bytes);
  if (digest !== asset.digest.slice("sha256:".length)) {
    throw new Error(
      `${asset.name} SHA-256 ${digest} differs from the release asset digest ${asset.digest}`,
    );
  }
  return {
    id: asset.id,
    name: asset.name,
    size: asset.size,
    sha256: digest,
    url: asset.url,
    bytes,
  };
}

// The checksum-list grammar `verifyChecksumAsset` in src/bootstrap.ts accepts.
function checksumLines(bytes: Buffer, count: number): Map<string, string> {
  if (bytes.includes(0) || !bytes.every((byte) => byte < 0x80)) {
    throw new Error(`${CHECKSUM_ASSET} is not ASCII text`);
  }
  const text = bytes.toString("ascii");
  if (!text.endsWith("\n")) {
    throw new Error(`${CHECKSUM_ASSET} does not end with a newline`);
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.length !== count) {
    throw new Error(
      `${CHECKSUM_ASSET} has ${lines.length} lines, not ${count}`,
    );
  }
  const digests = new Map<string, string>();
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9._-]+)$/u.exec(line);
    if (!match) throw new Error(`${CHECKSUM_ASSET} has malformed line ${line}`);
    if (digests.has(match[2]!)) {
      throw new Error(`${CHECKSUM_ASSET} lists ${match[2]} twice`);
    }
    digests.set(match[2]!, match[1]!);
  }
  return digests;
}

async function archiveInventory(bytes: Buffer): Promise<InventoryEntry[]> {
  const inventory: InventoryEntry[] = [];
  const extract = tar.extract();
  extract.on("entry", (header, stream, next) => {
    inventory.push({
      path: header.name.endsWith("/") ? header.name.slice(0, -1) : header.name,
      type: header.type ?? "",
      mode: header.mode === undefined ? -1 : header.mode & 0o7777,
      size: header.size ?? -1,
    });
    stream.on("end", next);
    stream.resume();
  });
  await pipeline(Readable.from([bytes]), createGunzip(), extract);
  return inventory;
}

function canonicalLayout(
  root: string,
  inventory: readonly InventoryEntry[],
): boolean {
  const sizes = inventory.map((entry) => entry.size);
  const shape = [
    { path: root, type: "directory", mode: 0o755, size: 0 },
    { path: `${root}/LICENSE`, type: "file", mode: 0o644, size: sizes[1] },
    { path: `${root}/README.md`, type: "file", mode: 0o644, size: sizes[2] },
    { path: `${root}/um`, type: "file", mode: 0o755, size: sizes[3] },
  ];
  return (
    isDeepStrictEqual(inventory, shape) &&
    sizes.slice(1).every((size) => Number.isSafeInteger(size) && size > 0)
  );
}

async function archiveRecord(
  dependencies: ReleaseEvidenceDependencies,
  asset: ReleaseAsset,
  root: string,
  listed: ReadonlyMap<string, string>,
): Promise<ArchiveRecord> {
  const verified = await downloadVerified(dependencies, asset);
  if (listed.get(asset.name) !== verified.sha256) {
    throw new Error(
      `${asset.name} SHA-256 ${verified.sha256} differs from its ${CHECKSUM_ASSET} line`,
    );
  }
  const inventory = await archiveInventory(verified.bytes).catch(
    (error: unknown) => {
      throw new Error(`${asset.name} is not a readable tar.gz archive`, {
        cause: error,
      });
    },
  );
  if (!canonicalLayout(root, inventory)) {
    throw new Error(
      `${asset.name} layout is not ${root}/ (0755) holding exactly LICENSE (0644), README.md (0644) and um (0755)`,
    );
  }
  return {
    id: verified.id,
    name: verified.name,
    size: verified.size,
    sha256: verified.sha256,
    url: verified.url,
    rootDirectory: root,
    inventory,
  };
}

// Reads one published `useful-machinery/um` release by tag and returns its
// evidence, or rejects naming the first property the release fails.
export async function generateReleaseEvidence(
  tag: string,
  dependencies: ReleaseEvidenceDependencies,
): Promise<ReleaseEvidence> {
  const version = /^v(\d+\.\d+\.\d+)$/u.exec(tag)?.[1];
  if (version === undefined) {
    throw new Error(`tag ${tag} is not v<major>.<minor>.<patch>`);
  }

  const releaseDocument: unknown = await (
    await fetchOk(dependencies, `${API}/releases/tags/${tag}`, apiHeaders())
  ).json();
  if (!isRecord(releaseDocument)) {
    throw new Error(`release ${tag} is not a JSON object`);
  }
  const context = `release ${tag}`;
  if (field(releaseDocument, "draft", isBoolean, context)) {
    throw new Error(`release ${tag} is a draft`);
  }
  if (field(releaseDocument, "prerelease", isBoolean, context)) {
    throw new Error(`release ${tag} is a prerelease`);
  }
  const tagName = field(releaseDocument, "tag_name", isString, context);
  if (tagName !== tag) {
    throw new Error(`release ${tag} answered with tag ${tagName}`);
  }
  const releaseId = field(releaseDocument, "id", isCount, context);
  const releaseUrl = field(releaseDocument, "html_url", isString, context);
  if (releaseUrl !== `${RELEASE_PAGE}/tag/${tag}`) {
    throw new Error(`release ${tag} has page URL ${releaseUrl}`);
  }
  const assets = releaseAssets(releaseDocument, tag, version);

  const commitDocument: unknown = await (
    await fetchOk(dependencies, `${API}/commits/${tag}`, apiHeaders())
  ).json();
  const commit = isRecord(commitDocument) ? commitDocument : {};
  const releaseCommit = field(
    commit,
    "sha",
    (value): value is string =>
      typeof value === "string" && /^[0-9a-f]{40}$/u.test(value),
    `tag ${tag} commit`,
  );
  const message = isRecord(commit.commit) ? commit.commit.message : undefined;
  if (typeof message !== "string") {
    throw new Error(`release commit ${releaseCommit} has no message`);
  }
  const trailers = [
    ...message.matchAll(/^Source-Revision: ([0-9a-f]{40})$/gmu),
  ].map((match) => match[1]!);
  if (trailers.length === 0) {
    throw new Error(
      `release commit ${releaseCommit} has no Source-Revision trailer`,
    );
  }
  if (trailers.length > 1) {
    throw new Error(
      `release commit ${releaseCommit} has ${trailers.length} Source-Revision trailers`,
    );
  }
  const sourceRevision = trailers[0]!;

  const checksum = await downloadVerified(
    dependencies,
    assets.get(CHECKSUM_ASSET)!,
  );
  const listed = checksumLines(checksum.bytes, TARGETS.length);
  const archives = {} as Record<Target, ArchiveRecord>;
  for (const target of TARGETS) {
    const root = `um-${version}-${target}`;
    archives[target] = await archiveRecord(
      dependencies,
      assets.get(`${root}.tar.gz`)!,
      root,
      listed,
    );
  }

  if (
    !(await dependencies.isAncestor(REQUIRED_SOURCE_ANCESTOR, sourceRevision))
  ) {
    throw new Error(
      `Source-Revision ${sourceRevision} does not descend from ${REQUIRED_SOURCE_ANCESTOR}`,
    );
  }

  return {
    schemaVersion: 1,
    repository: REPOSITORY,
    releaseUrl,
    tag,
    releaseId,
    releaseCommit,
    sourceRevision,
    requiredSourceAncestor: REQUIRED_SOURCE_ANCESTOR,
    version,
    buildIdentity: releaseCommit,
    checksumAsset: {
      id: checksum.id,
      name: checksum.name,
      size: checksum.size,
      sha256: checksum.sha256,
      url: checksum.url,
    },
    archives,
  };
}

// The committed form of release-evidence.json, which Prettier leaves unchanged.
export function serializeReleaseEvidence(evidence: ReleaseEvidence): string {
  return `${JSON.stringify(evidence, null, 2)}\n`;
}

const execFileAsync = promisify(execFile);

export function defaultDependencies(
  repository: string,
): ReleaseEvidenceDependencies {
  return {
    fetch: (url, headers) => fetch(url, { headers, redirect: "follow" }),
    isAncestor: async (ancestor, descendant) => {
      try {
        await execFileAsync("git", [
          "-C",
          repository,
          "merge-base",
          "--is-ancestor",
          ancestor,
          descendant,
        ]);
        return true;
      } catch (error) {
        const failure = error as { code?: unknown; stderr?: unknown };
        if (failure.code === 1) return false;
        const stderr = String(failure.stderr ?? "").trim();
        throw new Error(
          `git merge-base --is-ancestor ${ancestor} ${descendant} failed: ${stderr || String(error)}`,
        );
      }
    },
  };
}

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function main(argv: readonly string[]): Promise<number> {
  const usage =
    "usage: release-evidence.ts [--repository DIR] (<tag> | --check)";
  let repository = path.resolve(packageRoot, "../..");
  const rest = [...argv];
  if (rest[0] === "--repository") {
    if (rest[1] === undefined) {
      console.error(usage);
      return 2;
    }
    repository = path.resolve(rest[1]);
    rest.splice(0, 2);
  }
  const [mode] = rest;
  if (rest.length !== 1 || mode === undefined || mode === "") {
    console.error(usage);
    return 2;
  }
  const evidencePath = path.join(packageRoot, "release-evidence.json");
  const dependencies = defaultDependencies(repository);
  if (mode === "--check") {
    const committed = await readFile(evidencePath, "utf8");
    const tag = (JSON.parse(committed) as { tag?: unknown }).tag;
    if (typeof tag !== "string") {
      throw new Error("release-evidence.json has no tag");
    }
    const generated = serializeReleaseEvidence(
      await generateReleaseEvidence(tag, dependencies),
    );
    if (generated !== committed) {
      console.error(
        `release-evidence.json differs from the published ${tag} release`,
      );
      return 1;
    }
    return 0;
  }
  await writeFile(
    evidencePath,
    serializeReleaseEvidence(await generateReleaseEvidence(mode, dependencies)),
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
