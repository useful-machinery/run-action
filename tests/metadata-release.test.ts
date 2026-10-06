import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import evidence from "../release-evidence.json" with { type: "json" };
import { OUTPUT_NAMES } from "../src/github.ts";
import { PINNED_RELEASE } from "../src/release.ts";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const inputNames = [
  "workflow",
  "source-root",
  "execution-root",
  "inputs",
  "max-parallel",
  "export",
];

test("action.yml exposes only the V1 metadata surface and Node 24 bundle", async () => {
  const metadata = parse(
    await readFile(path.join(packageRoot, "action.yml"), "utf8"),
  ) as {
    inputs: Record<string, unknown>;
    outputs: Record<string, unknown>;
    runs: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(metadata.inputs), inputNames);
  assert.deepEqual(Object.keys(metadata.outputs), [...OUTPUT_NAMES]);
  assert.deepEqual(metadata.runs, { using: "node24", main: "dist/index.cjs" });
  assert.equal(
    (metadata.inputs.workflow as { required: boolean }).required,
    true,
  );
  for (const name of ["source-root", "execution-root"]) {
    assert.equal(
      (metadata.inputs[name] as { default: string }).default,
      "${{ github.workspace }}",
    );
  }
  assert.equal(
    (metadata.inputs["max-parallel"] as { default: string }).default,
    "1",
  );
});

test("public checks define source and all supported native behavior jobs", async () => {
  const workflow = parse(
    await readFile(
      path.join(packageRoot, ".github/workflows/check.yml"),
      "utf8",
    ),
  ) as {
    permissions: Record<string, string>;
    jobs: {
      source: { name: string; "runs-on": string };
      behavior: {
        name: string;
        "runs-on": string;
        strategy: { matrix: { runner: string[] } };
        steps: {
          uses?: string;
          with?: Record<string, unknown>;
          "continue-on-error"?: boolean;
        }[];
      };
    };
  };
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.source, {
    ...workflow.jobs.source,
    name: "Public source",
    "runs-on": "ubuntu-24.04",
  });
  assert.equal(workflow.jobs.behavior.name, "${{ matrix.runner }}");
  assert.equal(workflow.jobs.behavior["runs-on"], "${{ matrix.runner }}");
  assert.deepEqual(workflow.jobs.behavior.strategy.matrix.runner, [
    "ubuntu-24.04",
    "ubuntu-24.04-arm",
    "macos-15",
  ]);
  const actionSteps = workflow.jobs.behavior.steps.filter(
    ({ uses }) => uses === "./",
  );
  assert.deepEqual(
    actionSteps.map(
      ({ "continue-on-error": continueOnError }) => continueOnError ?? false,
    ),
    [false, true],
  );
  const namedInputs = JSON.parse(
    String(actionSteps[0]?.with?.inputs),
  ) as Record<string, { kind: string }>;
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(namedInputs).map(([name, input]) => [name, input.kind]),
    ),
    {
      pathText: "text",
      emptyText: "text",
      pathJson: "json",
      inlineJson: "json",
      emptyFile: "file",
      orderedItems: "attachments",
      emptyItems: "attachments",
    },
  );
});

test("traceability accounts for every V1 invariant and requirement", async () => {
  const traceability = JSON.parse(
    await readFile(path.join(packageRoot, "traceability.json"), "utf8"),
  ) as {
    schemaVersion: number;
    invariants: { id: string; owner: string; evidence: string[] }[];
    requirements: { id: string; owner: string; evidence: string[] }[];
  };
  assert.equal(traceability.schemaVersion, 1);
  assert.deepEqual(
    traceability.invariants.map(({ id }) => id),
    Array.from(
      { length: 11 },
      (_, index) => `GHA-RUN-INV-${String(index + 1).padStart(3, "0")}`,
    ),
  );
  assert.deepEqual(
    traceability.requirements.map(({ id }) => id),
    Array.from(
      { length: 31 },
      (_, index) => `GHA-RUN-${String(index + 1).padStart(3, "0")}`,
    ),
  );
  for (const entry of [
    ...traceability.invariants,
    ...traceability.requirements,
  ]) {
    assert.match(
      entry.owner,
      /^(action|artifact-set-delegated|cli-delegated|documentation|mirror|release)$/u,
    );
    assert.ok(entry.evidence.length > 0);
    assert.equal(
      entry.evidence.every((value) => value.length > 0),
      true,
    );
  }
});

test("release evidence is the closed observed v0.57.0 release", () => {
  assert.deepEqual(PINNED_RELEASE, evidence);
  assert.deepEqual(
    {
      repository: evidence.repository,
      releaseUrl: evidence.releaseUrl,
      tag: evidence.tag,
      releaseId: evidence.releaseId,
      releaseCommit: evidence.releaseCommit,
      sourceRevision: evidence.sourceRevision,
      requiredSourceAncestor: evidence.requiredSourceAncestor,
      version: evidence.version,
      buildIdentity: evidence.buildIdentity,
      checksumAsset: evidence.checksumAsset,
    },
    {
      repository: "useful-machinery/um",
      releaseUrl: "https://github.com/useful-machinery/um/releases/tag/v0.57.0",
      tag: "v0.57.0",
      releaseId: 404290732,
      releaseCommit: "e92b2e06fc603767239a23a6076a93a2e3e32fa2",
      sourceRevision: "c8deee65ec16c0f311c9d74cdccd6907561af53a",
      requiredSourceAncestor: "7215869ca26439d305c097af1dca50ebb8066419",
      version: "0.57.0",
      buildIdentity: "c8deee65ec16c0f311c9d74cdccd6907561af53a",
      checksumAsset: {
        id: 614393726,
        name: "SHA256SUMS",
        size: 321,
        sha256:
          "96ed3611bc4ec48733bce3a177d795b835f39c2b811918306e865765746a8a71",
        url: "https://github.com/useful-machinery/um/releases/download/v0.57.0/SHA256SUMS",
      },
    },
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(evidence.archives).map(([target, archive]) => [
        target,
        [archive.id, archive.name, archive.size, archive.sha256],
      ]),
    ),
    {
      "x86_64-unknown-linux-gnu": [
        614393724,
        "um-0.57.0-x86_64-unknown-linux-gnu.tar.gz",
        16432906,
        "8c33e713ed96e89f2fff18d2f27d480875d5cc037df3b760d7bc096193b2c6e5",
      ],
      "aarch64-unknown-linux-gnu": [
        614393727,
        "um-0.57.0-aarch64-unknown-linux-gnu.tar.gz",
        16902733,
        "f9e1d4e5fc1126b839855ba91b38123dfe217944d978177fa782a28717569b5f",
      ],
      "aarch64-apple-darwin": [
        614393725,
        "um-0.57.0-aarch64-apple-darwin.tar.gz",
        15179976,
        "a4f5f9bedb3f6a4570de2d898c9a4bb6d12b6c9cd6282ab469f43d0562da14ee",
      ],
    },
  );
  const serialized = JSON.stringify(evidence).toLowerCase();
  for (const forbidden of [
    "latest",
    "placeholder",
    "cli-version",
    "source-build",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
