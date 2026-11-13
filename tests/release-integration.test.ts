import assert from "node:assert/strict";
import { existsSync, watch } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bootstrapCli,
  DEFAULT_BOOTSTRAP_DEPENDENCIES,
} from "../src/bootstrap.ts";
import {
  type ActionDependencies,
  DEFAULT_ACTION_DEPENDENCIES,
  executeAction,
} from "../src/main.ts";
import { hostRunner } from "../scripts/stage-release.ts";

const releaseBundle = process.env.UM_RUN_ACTION_RELEASE_BUNDLE;

const allKindWorkflow = `schemaVersion: 1
inputs:
  inlineText:
    kind: text
  emptyText:
    kind: text
  inlineJson:
    kind: json
  fileJson:
    kind: json
  emptyFile:
    kind: file
    mediaType: application/octet-stream
  evidence:
    kind: attachments
  emptyEvidence:
    kind: attachments
steps:
  check:
    kind: cmd
    inputs:
      inlineText:
        ref: inputs.inlineText
      emptyText:
        ref: inputs.emptyText
      inlineJson:
        ref: inputs.inlineJson
      fileJson:
        ref: inputs.fileJson
      emptyFile:
        ref: inputs.emptyFile
      evidence:
        ref: inputs.evidence
      emptyEvidence:
        ref: inputs.emptyEvidence
    command:
      argv:
        - bash
        - -c
        - |
          set -euo pipefail
          test "$(cat "$UM_STEP_INPUTS/values/inlineText")" = release-check
          test ! -s "$UM_STEP_INPUTS/values/emptyText"
          test "$(cat "$UM_STEP_INPUTS/values/inlineJson")" = null
          test "$(cat "$UM_STEP_INPUTS/values/fileJson")" = '{"ok":true}'
          test ! -s "$UM_STEP_INPUTS/values/emptyFile"
          test "$(find "$UM_STEP_INPUTS/collections/evidence" -type f | wc -l | tr -d ' ')" = 1
          test "$(find "$UM_STEP_INPUTS/collections/emptyEvidence" -type f | wc -l | tr -d ' ')" = 0
`;

interface ReleaseRoot {
  readonly root: string;
  readonly workspace: string;
  readonly runnerTemp: string;
  readonly outputFile: string;
}

async function withReleaseRoot(
  body: (releaseRoot: ReleaseRoot) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "um-release-action-"));
  try {
    const workspace = path.join(root, "workspace");
    const runnerTemp = path.join(root, "runner-temp");
    await Promise.all([mkdir(workspace), mkdir(runnerTemp)]);
    await body({
      root,
      workspace,
      runnerTemp,
      outputFile: path.join(root, "github-output"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function releaseEnvironment(
  releaseRoot: ReleaseRoot,
  inputs: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const { runnerOS, runnerArch } = hostRunner();
  return {
    ...process.env,
    GITHUB_WORKSPACE: releaseRoot.workspace,
    RUNNER_TEMP: releaseRoot.runnerTemp,
    RUNNER_OS: runnerOS,
    RUNNER_ARCH: runnerArch,
    GITHUB_OUTPUT: releaseRoot.outputFile,
    GITHUB_PATH: path.join(releaseRoot.root, "github-path"),
    ...inputs,
  };
}

function releaseDependencies(bundle: string): ActionDependencies {
  return {
    ...DEFAULT_ACTION_DEPENDENCIES,
    bootstrap: (sourceEnvironment) =>
      bootstrapCli(sourceEnvironment, {
        ...DEFAULT_BOOTSTRAP_DEPENDENCIES,
        fetch: async (url) => {
          const name = path.posix.basename(new URL(url).pathname);
          const bytes = await readFile(path.join(bundle, name));
          return new Response(new Uint8Array(bytes), {
            status: 200,
            headers: { "content-length": String(bytes.length) },
          });
        },
      }),
  };
}

async function actionReservation(runnerTemp: string): Promise<string> {
  const reservations = (
    await readdir(runnerTemp, { withFileTypes: true })
  ).filter(
    (entry) =>
      entry.isDirectory() &&
      entry.name.startsWith(".um-run-") &&
      !entry.name.startsWith(".um-run-cli-"),
  );
  const [reservation, ...others] = reservations;
  assert.ok(reservation);
  assert.deepEqual(others, []);
  return path.join(runnerTemp, reservation.name);
}

// REQ-RUNACTION-32, REQ-RUNACTION-50, REQ-RUNACTION-58
test(
  "the staged pinned release executes one all-kind named-input Action invocation",
  { skip: releaseBundle === undefined },
  async () => {
    assert.ok(releaseBundle);
    await withReleaseRoot(async (releaseRoot) => {
      const { workspace } = releaseRoot;
      await Promise.all([
        writeFile(path.join(workspace, "workflow.yaml"), allKindWorkflow),
        writeFile(path.join(workspace, "value.json"), '{"ok":true}'),
        writeFile(path.join(workspace, "empty.bin"), ""),
        writeFile(path.join(workspace, "attachment.txt"), "attached\n"),
      ]);
      const environment = releaseEnvironment(releaseRoot, {
        INPUT_WORKFLOW: "workflow.yaml",
        INPUT_INPUTS: JSON.stringify({
          inlineText: { kind: "text", value: "release-check" },
          emptyText: { kind: "text", value: "" },
          inlineJson: { kind: "json", value: null },
          fileJson: { kind: "json", path: "value.json" },
          emptyFile: {
            kind: "file",
            mediaType: "application/octet-stream",
            path: "empty.bin",
          },
          evidence: {
            kind: "attachments",
            items: [{ mediaType: "text/plain", path: "attachment.txt" }],
          },
          emptyEvidence: { kind: "attachments", items: [] },
        }),
      });
      const result = await executeAction(
        environment,
        releaseDependencies(releaseBundle),
      );

      assert.equal(result.failure, undefined);
      assert.equal(result.outputs.outcome, "succeeded");
      assert.equal(
        await stat(result.outputs["result-path"]).then((value) =>
          value.isFile(),
        ),
        true,
      );
      const reservation = await actionReservation(releaseRoot.runnerTemp);
      assert.deepEqual(await readdir(reservation), ["run"]);
      const outputBytes = await readFile(releaseRoot.outputFile, "utf8");
      assert.equal(outputBytes.includes("release-check"), false);
      assert.equal(outputBytes.includes('{"ok":true}'), false);
    });
  },
);

// Resolves once `file` exists; the watcher is created before the check so a
// creation between the two is still observed.
function fileCreated(file: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const watcher = watch(path.dirname(file), { signal }, () => {
      if (existsSync(file)) watcher.close();
    });
    watcher.on("close", resolve);
    watcher.on("error", (error) => {
      if (!signal.aborted) reject(error);
    });
    if (existsSync(file)) watcher.close();
  });
}

// REQ-RUNACTION-41, REQ-RUNACTION-46, REQ-RUNACTION-47
test(
  "the staged pinned release recovers a cancelled run's outputs through its status",
  { skip: releaseBundle === undefined, timeout: 120_000 },
  async () => {
    assert.ok(releaseBundle);
    await withReleaseRoot(async (releaseRoot) => {
      const markers = path.join(releaseRoot.root, "markers");
      await mkdir(markers);
      const marker = path.join(markers, "step-started");
      const workflow = `schemaVersion: 1
steps:
  wait:
    kind: cmd
    command:
      argv:
        - bash
        - -c
        - 'touch "$1"; exec sleep 600'
        - bash
        - ${JSON.stringify(marker)}
`;
      await writeFile(
        path.join(releaseRoot.workspace, "workflow.yaml"),
        workflow,
      );
      const watching = new AbortController();
      const started = fileCreated(marker, watching.signal);
      const running = executeAction(
        releaseEnvironment(releaseRoot, { INPUT_WORKFLOW: "workflow.yaml" }),
        releaseDependencies(releaseBundle),
      );
      try {
        await Promise.race([
          started,
          running.then((early) => {
            assert.fail(
              `the Action finished before the step started: ${JSON.stringify(early)}`,
            );
          }),
        ]);
      } finally {
        watching.abort();
      }
      process.emit("SIGINT");
      const result = await running;

      assert.equal(result.failure?.code, "workflow_failed");
      assert.equal(result.outputs.outcome, "cancelled");
      const reservation = await actionReservation(releaseRoot.runnerTemp);
      const runDirectory = result.outputs["run-directory"];
      assert.equal(runDirectory, path.join(reservation, "run"));
      assert.equal((await stat(runDirectory)).isDirectory(), true);
      assert.equal(
        result.outputs["artifact-set-path"],
        path.join(runDirectory, "attempts", "000001", "result"),
      );
      assert.equal((await stat(result.outputs["result-path"])).isFile(), true);
      assert.deepEqual(await readdir(reservation), ["run"]);
    });
  },
);
