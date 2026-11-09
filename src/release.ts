import evidence from "../release-evidence.json" with { type: "json" };

import { AdapterError } from "./errors.ts";

export type TargetTriple = keyof typeof evidence.archives;
export type ArchiveEvidence = (typeof evidence.archives)[TargetTriple];
export type ReleaseEvidence = typeof evidence;

export const PINNED_RELEASE: ReleaseEvidence = evidence;

const PLATFORM_TARGETS: Readonly<Record<string, TargetTriple>> = {
  "Linux/X64": "x86_64-unknown-linux-gnu",
  "Linux/ARM64": "aarch64-unknown-linux-gnu",
  "macOS/ARM64": "aarch64-apple-darwin",
};

export function selectTarget(
  runnerOS: string | undefined,
  runnerArch: string | undefined,
): TargetTriple | undefined {
  return PLATFORM_TARGETS[`${runnerOS ?? ""}/${runnerArch ?? ""}`];
}

export type VersionSource = "bundled" | "requested" | "latest";

export type VersionSelection =
  | { kind: "bundled" }
  | { kind: "latest" }
  | { kind: "requested"; version: string };

// `MAJOR.MINOR.PATCH`, each part a decimal number without a leading zero.
const VERSION_SOURCE =
  "(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)";
const VERSION_PATTERN = new RegExp(`^${VERSION_SOURCE}$`, "u");

// The `um-version` grammar (REQ-RUNACTION-82): pure, untrimmed, and checked
// before anything is downloaded.
export function parseVersionSelection(
  value: string | undefined,
): VersionSelection {
  if (value === undefined || value === "") return { kind: "bundled" };
  if (value === "latest") return { kind: "latest" };
  if (VERSION_PATTERN.test(value)) return { kind: "requested", version: value };
  throw new AdapterError("input_invalid");
}

export const RELEASE_REPOSITORY_URL = "https://github.com/useful-machinery/um";
export const LATEST_RELEASE_URL = `${RELEASE_REPOSITORY_URL}/releases/latest`;
// The release page's redirect target; the tag's version obeys the same grammar.
export const LATEST_TAG_PATTERN = new RegExp(
  `^https://github\\.com/useful-machinery/um/releases/tag/v(${VERSION_SOURCE})$`,
  "u",
);

export interface SelectedArchive {
  readonly name: string;
  readonly url: string;
  readonly rootDirectory: string;
}

export interface SelectedReleaseAssets {
  readonly checksumsUrl: string;
  readonly archives: Readonly<Record<TargetTriple, SelectedArchive>>;
}

// Constructed names and URLs of a selected release (INV-EMBED-22).
export function selectedReleaseAssets(version: string): SelectedReleaseAssets {
  const base = `${RELEASE_REPOSITORY_URL}/releases/download/v${version}`;
  const targets = Object.keys(PINNED_RELEASE.archives) as TargetTriple[];
  return {
    checksumsUrl: `${base}/SHA256SUMS`,
    archives: Object.fromEntries(
      targets.map((target) => {
        const name = `um-${version}-${target}.tar.gz`;
        return [
          target,
          {
            name,
            url: `${base}/${name}`,
            rootDirectory: `um-${version}-${target}`,
          },
        ];
      }),
    ) as Record<TargetTriple, SelectedArchive>,
  };
}
