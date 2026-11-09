import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bootstrapCli,
  DEFAULT_BOOTSTRAP_DEPENDENCIES,
  MAXIMUM_ARCHIVE_BYTES,
  MAXIMUM_CHECKSUM_BYTES,
  type BootstrapDependencies,
} from "../src/bootstrap.ts";
import { AdapterError, type FailureCode } from "../src/errors.ts";
import {
  LATEST_RELEASE_URL,
  PINNED_RELEASE,
  RELEASE_REPOSITORY_URL,
  selectedReleaseAssets,
  type ReleaseEvidence,
  type TargetTriple,
  type VersionSelection,
} from "../src/release.ts";
import type { CapturedCommand } from "../src/subprocess.ts";
import { fakeCli, paddedJson } from "./fake-cli.ts";
import { archiveBytes, sha256, type TarMutation } from "./fake-release.ts";

const targets: readonly {
  runnerOS: string;
  runnerArch: string;
  target: TargetTriple;
}[] = [
  { runnerOS: "Linux", runnerArch: "X64", target: "x86_64-unknown-linux-gnu" },
  {
    runnerOS: "Linux",
    runnerArch: "ARM64",
    target: "aarch64-unknown-linux-gnu",
  },
  { runnerOS: "macOS", runnerArch: "ARM64", target: "aarch64-apple-darwin" },
];

interface Redirect {
  readonly status: number;
  readonly location?: string;
}

interface BootstrapFixture {
  readonly release: ReleaseEvidence;
  readonly version: string;
  readonly buildIdentity?: string;
  readonly responses: ReadonlyMap<string, Buffer>;
  readonly answers?: ReadonlyMap<string, () => Response>;
  readonly redirects?: ReadonlyMap<string, Redirect>;
}

interface Observations {
  fetched: string[];
  executables: string[];
  appended: string[];
  manual?: string[];
}

async function fixture(
  selectedTarget?: TargetTriple,
  mutation?: TarMutation,
): Promise<BootstrapFixture> {
  const release = structuredClone(PINNED_RELEASE) as ReleaseEvidence;
  const mutable = release as unknown as {
    checksumAsset: { url: string; size: number; sha256: string };
    archives: Record<
      TargetTriple,
      {
        name: string;
        url: string;
        size: number;
        sha256: string;
        rootDirectory: string;
        inventory: {
          path: string;
          type: "directory" | "file";
          mode: number;
          size: number;
        }[];
      }
    >;
  };
  const responses = new Map<string, Buffer>();
  const checksumLines: string[] = [];
  for (const { target } of targets) {
    const archive = mutable.archives[target];
    archive.url = `https://fixture.invalid/${archive.name}`;
    const built = await archiveBytes(
      archive.rootDirectory,
      target === selectedTarget ? mutation : undefined,
    );
    archive.size = built.bytes.length;
    archive.sha256 = sha256(built.bytes);
    archive.inventory = built.inventory;
    responses.set(archive.url, built.bytes);
    checksumLines.push(`${archive.sha256}  ${archive.name}`);
  }
  const checksums = Buffer.from(`${checksumLines.join("\n")}\n`);
  mutable.checksumAsset.url = "https://fixture.invalid/SHA256SUMS";
  mutable.checksumAsset.size = checksums.length;
  mutable.checksumAsset.sha256 = sha256(checksums);
  responses.set(mutable.checksumAsset.url, checksums);
  return { release, version: release.version, responses };
}

function dependencies(
  fixtureValue: BootstrapFixture,
  observations: Observations,
  versionChange?: (version: Record<string, unknown>) => void,
): BootstrapDependencies {
  return {
    fetch: async (url, redirect) => {
      if (redirect === "manual") {
        observations.manual?.push(url);
        const answer = fixtureValue.redirects?.get(url);
        if (!answer) return new Response(null, { status: 404 });
        return new Response(null, {
          status: answer.status,
          headers:
            answer.location === undefined ? {} : { location: answer.location },
        });
      }
      observations.fetched.push(url);
      const answer = fixtureValue.answers?.get(url);
      if (answer) return answer();
      const bytes = fixtureValue.responses.get(url);
      if (!bytes) return new Response(null, { status: 404 });
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { "content-length": String(bytes.length) },
      });
    },
    runVersion: async (executable, environment): Promise<CapturedCommand> => {
      observations.executables.push(executable);
      assert.equal(environment.INPUT_WORKFLOW, undefined);
      assert.equal(environment.GITHUB_OUTPUT, undefined);
      assert.match(
        environment.PATH ?? "",
        new RegExp(`^${path.dirname(executable)}`),
      );
      const version: Record<string, unknown> = {
        schemaVersion: 1,
        command: "um",
        version: fixtureValue.version,
        executablePath: await realpath(executable),
        buildIdentity:
          fixtureValue.buildIdentity ?? fixtureValue.release.buildIdentity,
      };
      versionChange?.(version);
      return {
        code: 0,
        signal: null,
        stdout: Buffer.from(`${JSON.stringify(version)}\n`),
        stdoutOverflow: false,
        stderrOverflow: false,
      };
    },
    appendPath: async (_file, directory) => {
      observations.appended.push(directory);
    },
  };
}

async function withRunnerTemp(
  callback: (runnerTemp: string) => Promise<void>,
): Promise<void> {
  const runnerTemp = await mkdtemp(path.join(os.tmpdir(), "um-bootstrap-"));
  try {
    await callback(runnerTemp);
  } finally {
    await rm(runnerTemp, { recursive: true, force: true });
  }
}

// REQ-RUNACTION-4, REQ-RUNACTION-7, REQ-RUNACTION-11, REQ-RUNACTION-12, REQ-RUNACTION-38, REQ-RUNACTION-67
// INV-EMBED-1
// INV-EMBED-3
test("all supported platforms verify and install only their closed archive", async (t) => {
  for (const platform of targets) {
    await t.test(platform.target, async () => {
      await withRunnerTemp(async (runnerTemp) => {
        const fixtureValue = await fixture();
        const observed = {
          fetched: [] as string[],
          executables: [] as string[],
          appended: [] as string[],
        };
        const result = await bootstrapCli(
          {
            RUNNER_OS: platform.runnerOS,
            RUNNER_ARCH: platform.runnerArch,
            RUNNER_TEMP: runnerTemp,
            GITHUB_PATH: path.join(runnerTemp, "github-path"),
            PATH: "/ambient/decoy:/caller/bin",
            INPUT_WORKFLOW: "private input",
            GITHUB_OUTPUT: "/private/command",
          },
          dependencies(fixtureValue, observed),
          fixtureValue.release,
        );
        const selected = fixtureValue.release.archives[platform.target];
        assert.deepEqual(observed.fetched, [
          fixtureValue.release.checksumAsset.url,
          selected.url,
        ]);
        assert.deepEqual(observed.executables, [result.executable]);
        assert.deepEqual(observed.appended, [result.cliDirectory]);
        assert.equal(result.version, fixtureValue.release.version);
        assert.equal(result.source, "bundled");
        assert.equal(result.buildIdentity, fixtureValue.release.buildIdentity);
        assert.equal(result.executable, path.join(result.cliDirectory, "um"));
        assert.equal(
          result.environment.PATH,
          `${result.cliDirectory}${path.delimiter}/ambient/decoy:/caller/bin`,
        );
      });
    });
  }
});

// REQ-RUNACTION-5
test("a supported runner temp may use a symlinked absolute path", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "um-bootstrap-link-"));
  try {
    const physicalTemp = path.join(directory, "physical");
    const runnerTemp = path.join(directory, "runner-temp");
    await mkdir(physicalTemp);
    await symlink(physicalTemp, runnerTemp, "dir");
    const fixtureValue = await fixture();
    const observed = {
      fetched: [] as string[],
      executables: [] as string[],
      appended: [] as string[],
    };

    const result = await bootstrapCli(
      {
        RUNNER_OS: "Linux",
        RUNNER_ARCH: "X64",
        RUNNER_TEMP: runnerTemp,
      },
      dependencies(fixtureValue, observed),
      fixtureValue.release,
    );

    assert.equal(result.executable, await realpath(result.executable));
    assert.deepEqual(observed.executables, [result.executable]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// REQ-RUNACTION-7, REQ-RUNACTION-9, REQ-RUNACTION-10, REQ-RUNACTION-11
// INV-EMBED-1
test("bootstrap failures stay closed before ambient fallback", async (t) => {
  await withRunnerTemp(async (runnerTemp) => {
    const platform = targets[0]!;
    const cases: readonly {
      name: string;
      code: FailureCode;
      prepare: (fixtureValue: BootstrapFixture) => Promise<{
        fixtureValue: BootstrapFixture;
        deps: BootstrapDependencies;
      }>;
    }[] = [
      {
        name: "retrieval",
        code: "bootstrap_download_failed",
        prepare: async (fixtureValue) => ({
          fixtureValue,
          deps: {
            ...dependencies(fixtureValue, {
              fetched: [],
              executables: [],
              appended: [],
            }),
            fetch: async () => {
              throw new Error("offline");
            },
          },
        }),
      },
      {
        name: "retrieval-status",
        code: "bootstrap_download_failed",
        prepare: async (fixtureValue) => ({
          fixtureValue,
          deps: {
            ...dependencies(fixtureValue, {
              fetched: [],
              executables: [],
              appended: [],
            }),
            fetch: async () => new Response(null, { status: 404 }),
          },
        }),
      },
      ...(["traversal", "link", "inventory", "mode"] as const).map(
        (mutation) => ({
          name: `tar-${mutation}`,
          code: "bootstrap_integrity_failed" as const,
          prepare: async () => {
            const fixtureValue = await fixture(platform.target, mutation);
            return {
              fixtureValue,
              deps: dependencies(fixtureValue, {
                fetched: [],
                executables: [],
                appended: [],
              }),
            };
          },
        }),
      ),
      ...(
        [
          "schemaVersion",
          "command",
          "version",
          "executablePath",
          "buildIdentity",
        ] as const
      ).map((field) => ({
        name: `version-${field}`,
        code: "bootstrap_version_failed" as const,
        prepare: async (fixtureValue: BootstrapFixture) => ({
          fixtureValue,
          deps: dependencies(
            fixtureValue,
            { fetched: [], executables: [], appended: [] },
            (version) => {
              version[field] = field === "schemaVersion" ? 2 : "wrong";
            },
          ),
        }),
      })),
    ];

    for (const scenario of cases) {
      await t.test(scenario.name, async () => {
        const base = await fixture();
        const prepared = await scenario.prepare(base);
        await assert.rejects(
          bootstrapCli(
            {
              RUNNER_OS: platform.runnerOS,
              RUNNER_ARCH: platform.runnerArch,
              RUNNER_TEMP: runnerTemp,
              PATH: "/ambient/successful-decoy",
            },
            prepared.deps,
            prepared.fixtureValue.release,
          ),
          (error: unknown) =>
            error instanceof AdapterError && error.code === scenario.code,
        );
      });
    }
  });
});

// REQ-RUNACTION-8
// INV-EMBED-1
test("checksum and archive byte corruption fail before version inspection", async () => {
  await withRunnerTemp(async (runnerTemp) => {
    const fixtureValue = await fixture();
    const platform = targets[0]!;
    for (const url of [
      fixtureValue.release.checksumAsset.url,
      fixtureValue.release.archives[platform.target].url,
    ]) {
      let versionRuns = 0;
      const corrupted = new Map(fixtureValue.responses);
      const bytes = Buffer.from(corrupted.get(url)!);
      bytes[0] = (bytes[0] ?? 0) ^ 0xff;
      corrupted.set(url, bytes);
      const changed = { ...fixtureValue, responses: corrupted };
      const deps = dependencies(changed, {
        fetched: [],
        executables: [],
        appended: [],
      });
      const wrapped: BootstrapDependencies = {
        ...deps,
        runVersion: async (...arguments_) => {
          versionRuns += 1;
          return deps.runVersion(...arguments_);
        },
      };
      await assert.rejects(
        bootstrapCli(
          {
            RUNNER_OS: platform.runnerOS,
            RUNNER_ARCH: platform.runnerArch,
            RUNNER_TEMP: runnerTemp,
          },
          wrapped,
          fixtureValue.release,
        ),
        AdapterError,
      );
      assert.equal(versionRuns, 0);
    }
  });
});

// REQ-RUNACTION-8
// INV-EMBED-1
test("archive size and checksum layout drift fail before version inspection", async (t) => {
  await withRunnerTemp(async (runnerTemp) => {
    const platform = targets[0]!;
    await t.test("archive size", async () => {
      const fixtureValue = await fixture();
      const archiveUrl = fixtureValue.release.archives[platform.target].url;
      const responses = new Map(fixtureValue.responses);
      responses.set(
        archiveUrl,
        Buffer.concat([responses.get(archiveUrl)!, Buffer.from([0])]),
      );
      let versionRuns = 0;
      const changed = { ...fixtureValue, responses };
      const base = dependencies(changed, {
        fetched: [],
        executables: [],
        appended: [],
      });
      await assert.rejects(
        bootstrapCli(
          {
            RUNNER_OS: platform.runnerOS,
            RUNNER_ARCH: platform.runnerArch,
            RUNNER_TEMP: runnerTemp,
          },
          {
            ...base,
            runVersion: async (...arguments_) => {
              versionRuns += 1;
              return base.runVersion(...arguments_);
            },
          },
          fixtureValue.release,
        ),
        AdapterError,
      );
      assert.equal(versionRuns, 0);
    });

    await t.test("checksum layout", async () => {
      const fixtureValue = await fixture();
      const release = structuredClone(fixtureValue.release) as ReleaseEvidence;
      const checksumUrl = release.checksumAsset.url;
      const changedBytes = Buffer.from(
        fixtureValue.responses.get(checksumUrl)!,
      );
      changedBytes[0] = changedBytes[0] === 0x30 ? 0x31 : 0x30;
      const mutableChecksum = release.checksumAsset as {
        size: number;
        sha256: string;
      };
      mutableChecksum.size = changedBytes.length;
      mutableChecksum.sha256 = sha256(changedBytes);
      const responses = new Map(fixtureValue.responses);
      responses.set(checksumUrl, changedBytes);
      const changed = { ...fixtureValue, release, responses };
      await assert.rejects(
        bootstrapCli(
          {
            RUNNER_OS: platform.runnerOS,
            RUNNER_ARCH: platform.runnerArch,
            RUNNER_TEMP: runnerTemp,
          },
          dependencies(changed, {
            fetched: [],
            executables: [],
            appended: [],
          }),
          release,
        ),
        AdapterError,
      );
    });
  });
});

// REQ-RUNACTION-4
// INV-EMBED-1
test("unsupported platform fails without retrieval", async () => {
  let fetches = 0;
  await assert.rejects(
    bootstrapCli(
      { RUNNER_OS: "Windows", RUNNER_ARCH: "X64" },
      {
        fetch: async () => {
          fetches += 1;
          return new Response();
        },
        runVersion: () => {
          throw new Error("must not run");
        },
        appendPath: async () => undefined,
      },
    ),
    (error: unknown) =>
      error instanceof AdapterError &&
      error.code === "bootstrap_platform_unsupported",
  );
  assert.equal(fetches, 0);
});

// REQ-RUNACTION-78
test("CLI version output is read up to its 65,536-byte bound", async (t) => {
  for (const [size, accepted] of [
    [65_536, true],
    [65_537, false],
  ] as const) {
    await t.test(String(size), async () => {
      await withRunnerTemp(async (runnerTemp) => {
        const scratch = await mkdtemp(path.join(os.tmpdir(), "um-version-"));
        try {
          const fixtureValue = await fixture();
          const deps: BootstrapDependencies = {
            ...dependencies(fixtureValue, {
              fetched: [],
              executables: [],
              appended: [],
            }),
            runVersion: async (executable, environment) =>
              DEFAULT_BOOTSTRAP_DEPENDENCIES.runVersion(
                await fakeCli(
                  scratch,
                  "um",
                  paddedJson(
                    {
                      schemaVersion: 1,
                      command: "um",
                      version: fixtureValue.release.version,
                      executablePath: await realpath(executable),
                      buildIdentity: fixtureValue.release.buildIdentity,
                    },
                    size,
                  ),
                ),
                environment,
              ),
          };
          const bootstrapping = bootstrapCli(
            { RUNNER_OS: "Linux", RUNNER_ARCH: "X64", RUNNER_TEMP: runnerTemp },
            deps,
            fixtureValue.release,
          );
          if (accepted) {
            await bootstrapping;
          } else {
            await assert.rejects(
              bootstrapping,
              (error: unknown) =>
                error instanceof AdapterError &&
                error.code === "bootstrap_version_failed",
            );
          }
        } finally {
          await rm(scratch, { recursive: true, force: true });
        }
      });
    });
  }
});

const SELECTED_VERSION = "9.8.7";
const SELECTED_IDENTITY = "0123456789abcdef0123456789abcdef01234567";
const SELECTED_TARGET: TargetTriple = "x86_64-unknown-linux-gnu";
const PINNED_URLS: ReadonlySet<string> = new Set([
  PINNED_RELEASE.checksumAsset.url,
  ...Object.values(PINNED_RELEASE.archives).map((archive) => archive.url),
]);

// Builds a published release `version` keyed by the URLs the Action constructs
// for it, with `releases/latest` redirecting to its tag.
async function selectedFixture(
  version: string,
  options: {
    mutation?: TarMutation;
    checksums?: (lines: string[]) => string;
  } = {},
): Promise<BootstrapFixture> {
  const assets = selectedReleaseAssets(version);
  const responses = new Map<string, Buffer>();
  const lines: string[] = [];
  for (const { target } of targets) {
    const archive = assets.archives[target];
    const built = await archiveBytes(
      archive.rootDirectory,
      target === SELECTED_TARGET ? options.mutation : undefined,
    );
    responses.set(archive.url, built.bytes);
    lines.push(`${sha256(built.bytes)}  ${archive.name}`);
  }
  responses.set(
    assets.checksumsUrl,
    Buffer.from(options.checksums?.(lines) ?? `${lines.join("\n")}\n`),
  );
  return {
    release: PINNED_RELEASE,
    version,
    buildIdentity: SELECTED_IDENTITY,
    responses,
    redirects: new Map([
      [
        LATEST_RELEASE_URL,
        {
          status: 302,
          location: `${RELEASE_REPOSITORY_URL}/releases/tag/v${version}`,
        },
      ],
    ]),
  };
}

function newObservations(): Required<Observations> {
  return { fetched: [], executables: [], appended: [], manual: [] };
}

// Runs a selected-release bootstrap that must fail with `code`, and checks
// that the failure installed nothing and substituted nothing.
async function selectedFailure(
  fixtureValue: BootstrapFixture,
  selection: VersionSelection,
  code: FailureCode,
  versionChange?: (version: Record<string, unknown>) => void,
): Promise<Required<Observations>> {
  const observed = newObservations();
  await withRunnerTemp(async (runnerTemp) => {
    await assert.rejects(
      bootstrapCli(
        {
          RUNNER_OS: "Linux",
          RUNNER_ARCH: "X64",
          RUNNER_TEMP: runnerTemp,
          PATH: "/ambient/successful-decoy",
        },
        dependencies(fixtureValue, observed, versionChange),
        undefined,
        selection,
      ),
      (error: unknown) => error instanceof AdapterError && error.code === code,
    );
    assert.deepEqual(await readdir(runnerTemp), []);
  });
  assert.deepEqual(observed.appended, []);
  assert.ok(observed.fetched.every((url) => !PINNED_URLS.has(url)));
  return observed;
}

const requested: VersionSelection = {
  kind: "requested",
  version: SELECTED_VERSION,
};

// REQ-RUNACTION-82, REQ-RUNACTION-83
// INV-EMBED-22
test("a selected release installs from its constructed URLs", async (t) => {
  for (const [selection, source] of [
    [{ kind: "latest" }, "latest"],
    [requested, "requested"],
  ] as const) {
    await t.test(source, async () => {
      await withRunnerTemp(async (runnerTemp) => {
        const fixtureValue = await selectedFixture(SELECTED_VERSION);
        const observed = newObservations();
        const result = await bootstrapCli(
          {
            RUNNER_OS: "Linux",
            RUNNER_ARCH: "X64",
            RUNNER_TEMP: runnerTemp,
            PATH: "/ambient/decoy",
          },
          dependencies(fixtureValue, observed),
          undefined,
          selection,
        );
        const assets = selectedReleaseAssets(SELECTED_VERSION);
        const archive = assets.archives[SELECTED_TARGET];
        assert.deepEqual(
          observed.manual,
          source === "latest" ? [LATEST_RELEASE_URL] : [],
        );
        assert.deepEqual(observed.fetched, [assets.checksumsUrl, archive.url]);
        assert.equal(result.version, SELECTED_VERSION);
        assert.equal(result.source, source);
        assert.equal(result.buildIdentity, SELECTED_IDENTITY);
        assert.equal(path.basename(result.cliDirectory), archive.rootDirectory);
        assert.equal(result.executable, path.join(result.cliDirectory, "um"));
        assert.deepEqual(observed.executables, [result.executable]);
        assert.deepEqual(observed.appended, [result.cliDirectory]);
      });
    });
  }
});

// REQ-RUNACTION-7, REQ-RUNACTION-11
// INV-EMBED-22
test("an unpublished or unreachable selected checksum list stops before the archive", async (t) => {
  const checksumsUrl = selectedReleaseAssets(SELECTED_VERSION).checksumsUrl;
  await t.test("unpublished", async () => {
    const fixtureValue = await selectedFixture(SELECTED_VERSION);
    const responses = new Map(fixtureValue.responses);
    responses.delete(checksumsUrl);
    const observed = await selectedFailure(
      { ...fixtureValue, responses },
      requested,
      "bootstrap_release_unavailable",
    );
    assert.deepEqual(observed.fetched, [checksumsUrl]);
  });
  await t.test("server error", async () => {
    const fixtureValue = await selectedFixture(SELECTED_VERSION);
    const observed = await selectedFailure(
      {
        ...fixtureValue,
        answers: new Map([
          [checksumsUrl, () => new Response(null, { status: 500 })],
        ]),
      },
      requested,
      "bootstrap_download_failed",
    );
    assert.deepEqual(observed.fetched, [checksumsUrl]);
  });
});

// REQ-RUNACTION-83, REQ-RUNACTION-67
// INV-EMBED-22
test("latest resolves only from a release-page redirect to a stable tag", async (t) => {
  const cases: readonly [string, Redirect | undefined][] = [
    ["not found", undefined],
    ["not a redirect", { status: 200 }],
    ["no location", { status: 302 }],
    [
      "prerelease tag",
      {
        status: 302,
        location: `${RELEASE_REPOSITORY_URL}/releases/tag/v${SELECTED_VERSION}-rc1`,
      },
    ],
    [
      "another repository",
      {
        status: 302,
        location: `https://github.com/useful-machinery/other/releases/tag/v${SELECTED_VERSION}`,
      },
    ],
    [
      "leading-zero tag",
      {
        status: 302,
        location: `${RELEASE_REPOSITORY_URL}/releases/tag/v09.8.7`,
      },
    ],
  ];
  for (const [name, redirect] of cases) {
    await t.test(name, async () => {
      const fixtureValue = await selectedFixture(SELECTED_VERSION);
      const observed = await selectedFailure(
        {
          ...fixtureValue,
          redirects: new Map(
            redirect === undefined ? [] : [[LATEST_RELEASE_URL, redirect]],
          ),
        },
        { kind: "latest" },
        "bootstrap_release_discovery_failed",
      );
      assert.deepEqual(observed.manual, [LATEST_RELEASE_URL]);
      assert.deepEqual(observed.fetched, []);
    });
  }
});

// REQ-RUNACTION-8, REQ-RUNACTION-9, REQ-RUNACTION-11
// INV-EMBED-22
test("a selected release's checksum list, archive and layout fail closed before the probe", async (t) => {
  const assets = selectedReleaseAssets(SELECTED_VERSION);
  const archiveUrl = assets.archives[SELECTED_TARGET].url;
  const listed = (lines: string[]): string => `${lines.join("\n")}\n`;
  const cases: readonly [string, () => Promise<BootstrapFixture>][] = [
    [
      "checksum list over its bound",
      () =>
        selectedFixture(SELECTED_VERSION, {
          checksums: (lines) =>
            listed(lines).padEnd(MAXIMUM_CHECKSUM_BYTES + 1, "\n"),
        }),
    ],
    [
      "checksum list not ASCII",
      () =>
        selectedFixture(SELECTED_VERSION, {
          checksums: (lines) =>
            listed([lines[0]!, lines[1]!, lines[2]!.replace("um-", "üm-")]),
        }),
    ],
    [
      "two lines",
      () =>
        selectedFixture(SELECTED_VERSION, {
          checksums: (lines) => listed(lines.slice(0, 2)),
        }),
    ],
    [
      "four lines",
      () =>
        selectedFixture(SELECTED_VERSION, {
          checksums: (lines) =>
            listed([...lines, `${"0".repeat(64)}  um-extra.tar.gz`]),
        }),
    ],
    [
      "wrong archive",
      () =>
        selectedFixture(SELECTED_VERSION, {
          checksums: (lines) =>
            listed([
              lines[0]!,
              lines[1]!,
              lines[2]!.replace("aarch64-apple-darwin", "x86_64-apple-darwin"),
            ]),
        }),
    ],
    [
      "duplicate archive",
      () =>
        selectedFixture(SELECTED_VERSION, {
          checksums: (lines) => listed([lines[0]!, lines[1]!, lines[1]!]),
        }),
    ],
    [
      "archive digest differs from its line",
      async () => {
        const fixtureValue = await selectedFixture(SELECTED_VERSION);
        const responses = new Map(fixtureValue.responses);
        const bytes = Buffer.from(responses.get(archiveUrl)!);
        bytes[0] = (bytes[0] ?? 0) ^ 0xff;
        responses.set(archiveUrl, bytes);
        return { ...fixtureValue, responses };
      },
    ],
    [
      "archive content-length over its bound",
      async () => ({
        ...(await selectedFixture(SELECTED_VERSION)),
        answers: new Map([
          [
            archiveUrl,
            () =>
              new Response(new Uint8Array(1), {
                headers: {
                  "content-length": String(MAXIMUM_ARCHIVE_BYTES + 1),
                },
              }),
          ],
        ]),
      }),
    ],
    [
      "archive body over its bound",
      async () => ({
        ...(await selectedFixture(SELECTED_VERSION)),
        answers: new Map([
          [
            archiveUrl,
            () =>
              new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(
                      new Uint8Array(MAXIMUM_ARCHIVE_BYTES + 1),
                    );
                    controller.close();
                  },
                }),
              ),
          ],
        ]),
      }),
    ],
    ...(["inventory", "link", "traversal", "mode"] as const).map(
      (mutation): [string, () => Promise<BootstrapFixture>] => [
        `tar-${mutation}`,
        () => selectedFixture(SELECTED_VERSION, { mutation }),
      ],
    ),
  ];
  for (const [name, prepare] of cases) {
    await t.test(name, async () => {
      const observed = await selectedFailure(
        await prepare(),
        requested,
        "bootstrap_integrity_failed",
      );
      assert.deepEqual(observed.executables, []);
    });
  }
});

// REQ-RUNACTION-10, REQ-RUNACTION-11
// INV-EMBED-22
test("a selected release's probe must report its version and a commit identity", async (t) => {
  const cases: readonly [string, string, string][] = [
    ["another version", "version", "9.8.8"],
    ["unknown identity", "buildIdentity", "unknown"],
    ["short identity", "buildIdentity", "a".repeat(39)],
  ];
  for (const [name, field, value] of cases) {
    await t.test(name, async () => {
      const observed = await selectedFailure(
        await selectedFixture(SELECTED_VERSION),
        { kind: "latest" },
        "bootstrap_version_failed",
        (version) => {
          version[field] = value;
        },
      );
      assert.equal(observed.executables.length, 1);
    });
  }
});

// REQ-RUNACTION-4, REQ-RUNACTION-5, REQ-RUNACTION-83
test("latest is not resolved on an unsupported platform or runner temp", async (t) => {
  const environments: readonly [string, NodeJS.ProcessEnv][] = [
    ["platform", { RUNNER_OS: "Windows", RUNNER_ARCH: "X64" }],
    [
      "relative runner temp",
      { RUNNER_OS: "Linux", RUNNER_ARCH: "X64", RUNNER_TEMP: "temp" },
    ],
    [
      "missing runner temp",
      {
        RUNNER_OS: "Linux",
        RUNNER_ARCH: "X64",
        RUNNER_TEMP: path.join(os.tmpdir(), "um-missing-runner-temp-0"),
      },
    ],
  ];
  for (const [name, environment] of environments) {
    await t.test(name, async () => {
      const observed = newObservations();
      await assert.rejects(
        bootstrapCli(
          environment,
          dependencies(await selectedFixture(SELECTED_VERSION), observed),
          undefined,
          { kind: "latest" },
        ),
        (error: unknown) =>
          error instanceof AdapterError &&
          error.code === "bootstrap_platform_unsupported",
      );
      assert.deepEqual(observed.manual, []);
      assert.deepEqual(observed.fetched, []);
    });
  }
});
