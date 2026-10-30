import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { PINNED_RELEASE, selectTarget } from "../src/release.ts";

const RUNNER_OS: Readonly<Record<string, string>> = {
  darwin: "macOS",
  linux: "Linux",
};
const RUNNER_ARCH: Readonly<Record<string, string>> = {
  x64: "X64",
  arm64: "ARM64",
};

// The GitHub runner's RUNNER_OS and RUNNER_ARCH for this host.
export function hostRunner(): {
  runnerOS: string | undefined;
  runnerArch: string | undefined;
} {
  return {
    runnerOS: RUNNER_OS[process.platform],
    runnerArch: RUNNER_ARCH[process.arch],
  };
}

// Downloads the pinned checksum asset and this host's archive, unverified:
// the release integration test bootstraps from them exactly as a runner does.
export async function stageRelease(destination: string): Promise<void> {
  const { runnerOS, runnerArch } = hostRunner();
  const target = selectTarget(runnerOS, runnerArch);
  if (target === undefined) {
    throw new Error(
      `unsupported host ${process.platform}/${process.arch}: the pinned release has no archive for it`,
    );
  }
  await mkdir(destination).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`${destination} already exists`);
    }
    throw error;
  });
  for (const asset of [
    PINNED_RELEASE.checksumAsset,
    PINNED_RELEASE.archives[target],
  ]) {
    const response = await fetch(asset.url, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(`${asset.url} returned HTTP ${response.status}`);
    }
    await writeFile(
      path.join(destination, asset.name),
      new Uint8Array(await response.arrayBuffer()),
      { flag: "wx" },
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const destination = process.argv[2];
  if (process.argv.length !== 3 || !destination) {
    console.error("usage: stage-release.ts DESTINATION");
    process.exit(2);
  }
  try {
    await stageRelease(path.resolve(destination));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
