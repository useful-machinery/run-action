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
  "um-version",
];

// REQ-RUNACTION-3, REQ-RUNACTION-14, REQ-RUNACTION-15, REQ-RUNACTION-42, REQ-RUNACTION-67
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
  assert.equal(OUTPUT_NAMES[0], "um-version");
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
  const umVersion = metadata.inputs["um-version"] as Record<string, unknown>;
  assert.equal(umVersion.required, false);
  assert.equal(Object.hasOwn(umVersion, "default"), false);
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
      release: {
        "runs-on": string;
        strategy: { matrix: { runner: string[] } };
        steps: { run?: string; env?: Record<string, string> }[];
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
  const release = workflow.jobs.release;
  assert.equal(release["runs-on"], "${{ matrix.runner }}");
  assert.deepEqual(
    release.strategy.matrix.runner,
    workflow.jobs.behavior.strategy.matrix.runner,
  );
  const releaseRun = release.steps.find(({ run }) => {
    const staged = run?.indexOf("scripts/stage-release.ts") ?? -1;
    return (
      staged >= 0 &&
      run!.indexOf("tests/release-integration.test.ts", staged) > staged
    );
  });
  assert.ok(releaseRun);
  assert.ok(releaseRun.env?.UM_RUN_ACTION_RELEASE_BUNDLE);
});

// REQ-RUNACTION-6, REQ-RUNACTION-81, REQ-ONBOARD-4
// INV-EMBED-1
test("release evidence is a closed, internally consistent stable release", async () => {
  assert.deepEqual(PINNED_RELEASE, evidence);
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.repository, "useful-machinery/um");
  assert.match(evidence.version, /^\d+\.\d+\.\d+$/u);
  const { tag, version } = evidence;
  assert.equal(tag, `v${version}`);
  assert.equal(
    evidence.releaseUrl,
    `https://github.com/useful-machinery/um/releases/tag/${tag}`,
  );
  assert.ok(Number.isInteger(evidence.releaseId) && evidence.releaseId > 0);
  for (const revision of [
    evidence.releaseCommit,
    evidence.sourceRevision,
    evidence.requiredSourceAncestor,
  ]) {
    assert.match(revision, /^[0-9a-f]{40}$/u);
  }
  assert.equal(evidence.buildIdentity, evidence.releaseCommit);
  assert.equal(
    evidence.requiredSourceAncestor,
    "7215869ca26439d305c097af1dca50ebb8066419",
  );
  const download = `https://github.com/useful-machinery/um/releases/download/${tag}`;
  assert.equal(evidence.checksumAsset.name, "SHA256SUMS");
  assert.equal(evidence.checksumAsset.url, `${download}/SHA256SUMS`);
  assert.match(evidence.checksumAsset.sha256, /^[0-9a-f]{64}$/u);
  assert.ok(evidence.checksumAsset.size > 0);
  assert.deepEqual(Object.keys(evidence.archives), [
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
    "aarch64-apple-darwin",
  ]);
  for (const [target, archive] of Object.entries(evidence.archives)) {
    const root = `um-${version}-${target}`;
    assert.equal(archive.name, `${root}.tar.gz`);
    assert.equal(archive.url, `${download}/${archive.name}`);
    assert.equal(archive.rootDirectory, root);
    assert.deepEqual(
      archive.inventory.map((entry) => ({
        path: entry.path,
        type: entry.type,
        mode: entry.mode,
      })),
      [
        { path: root, type: "directory", mode: 493 },
        { path: `${root}/LICENSE`, type: "file", mode: 420 },
        { path: `${root}/README.md`, type: "file", mode: 420 },
        { path: `${root}/um`, type: "file", mode: 493 },
      ],
    );
    assert.equal(archive.inventory[0]?.size, 0);
    for (const entry of archive.inventory.slice(1)) {
      assert.ok(Number.isInteger(entry.size) && entry.size > 0);
    }
    assert.match(archive.sha256, /^[0-9a-f]{64}$/u);
    assert.ok(archive.size > 0);
  }
  const readme = await readFile(path.join(packageRoot, "README.md"), "utf8");
  assert.ok(readme.includes(`\`um\` v${version}`));
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
