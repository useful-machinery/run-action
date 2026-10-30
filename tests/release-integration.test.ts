import assert from "node:assert/strict";
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
import { DEFAULT_ACTION_DEPENDENCIES, executeAction } from "../src/main.ts";
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

// REQ-RUNACTION-32, REQ-RUNACTION-50, REQ-RUNACTION-58
test(
  "the staged pinned release executes one all-kind named-input Action invocation",
  { skip: releaseBundle === undefined },
  async () => {
    assert.ok(releaseBundle);
    const root = await mkdtemp(path.join(os.tmpdir(), "um-release-action-"));
    try {
      const workspace = path.join(root, "workspace");
      const runnerTemp = path.join(root, "runner-temp");
      await mkdir(workspace);
      await Promise.all([
        writeFile(path.join(workspace, "workflow.yaml"), allKindWorkflow),
        writeFile(path.join(workspace, "value.json"), '{"ok":true}'),
        writeFile(path.join(workspace, "empty.bin"), ""),
        writeFile(path.join(workspace, "attachment.txt"), "attached\n"),
        mkdir(runnerTemp),
      ]);
      const { runnerOS, runnerArch } = hostRunner();
      const outputFile = path.join(root, "github-output");
      const pathFile = path.join(root, "github-path");
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: runnerTemp,
        RUNNER_OS: runnerOS,
        RUNNER_ARCH: runnerArch,
        GITHUB_OUTPUT: outputFile,
        GITHUB_PATH: pathFile,
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
      };
      const result = await executeAction(environment, {
        ...DEFAULT_ACTION_DEPENDENCIES,
        bootstrap: (sourceEnvironment) =>
          bootstrapCli(sourceEnvironment, {
            ...DEFAULT_BOOTSTRAP_DEPENDENCIES,
            fetch: async (url) => {
              const name = path.posix.basename(new URL(url).pathname);
              const bytes = await readFile(path.join(releaseBundle, name));
              return new Response(new Uint8Array(bytes), {
                status: 200,
                headers: { "content-length": String(bytes.length) },
              });
            },
          }),
      });

      assert.equal(result.failure, undefined);
      assert.equal(result.outputs.outcome, "succeeded");
      assert.equal(
        await stat(result.outputs["result-path"]).then((value) =>
          value.isFile(),
        ),
        true,
      );
      const allocations = (
        await readdir(runnerTemp, { withFileTypes: true })
      ).filter(
        (entry) => entry.isDirectory() && entry.name.startsWith(".um-run-"),
      );
      const actionAllocation = allocations.find(
        (entry) => !entry.name.startsWith(".um-run-cli-"),
      );
      assert.ok(actionAllocation);
      const actionEntries = await readdir(
        path.join(runnerTemp, actionAllocation.name),
      );
      assert.deepEqual(actionEntries, ["run"]);
      const outputBytes = await readFile(outputFile, "utf8");
      assert.equal(outputBytes.includes("release-check"), false);
      assert.equal(outputBytes.includes('{"ok":true}'), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
