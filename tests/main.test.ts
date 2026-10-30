import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { BootstrapResult } from "../src/bootstrap.ts";
import {
  AdapterError,
  type FailureCode,
  type FailureDiagnostic,
} from "../src/errors.ts";
import {
  allocateExecution,
  cleanupExecution,
  type ExecutionAllocation,
  type WorkflowProcessResult,
} from "../src/execution.ts";
import { emptyOutputs, type ActionOutputs } from "../src/github.ts";
import { recoverDurableRun } from "../src/identity.ts";
import { readActionInputs, type ActionInputs } from "../src/inputs.ts";
import { executeAction, type ActionDependencies } from "../src/main.ts";
import type {
  SelectedProjection,
  ValidatedResultProjection,
} from "../src/result.ts";
import type { TerminalEnvelope } from "../src/terminal.ts";

function unreachable<T>(): Promise<T> {
  throw new Error("unexpected test dependency call");
}

// REQ-RUNACTION-13, REQ-RUNACTION-42
// INV-EMBED-2
test("bootstrap rejection precedes every workflow input read and launch", async () => {
  let inputReads = 0;
  let launches = 0;
  let observedOutputs: ActionOutputs | undefined;
  const dependencies: ActionDependencies = {
    bootstrap: async () => {
      throw new AdapterError("bootstrap_integrity_failed");
    },
    readInputs: async () => {
      inputReads += 1;
      return unreachable<ActionInputs>();
    },
    allocate: () => unreachable<ExecutionAllocation>(),
    execute: async () => {
      launches += 1;
      return unreachable<WorkflowProcessResult>();
    },
    readTerminal: () => unreachable<TerminalEnvelope>(),
    recover: async () => undefined,
    project: () => unreachable<ValidatedResultProjection>(),
    writeOutputs: async (_file, outputs) => {
      observedOutputs = { ...outputs };
    },
    cleanup: async () => undefined,
  };
  const result = await executeAction(
    { GITHUB_OUTPUT: "/retained/output" },
    dependencies,
  );
  assert.equal(result.failure?.code, "bootstrap_integrity_failed");
  assert.equal(inputReads, 0);
  assert.equal(launches, 0);
  assert.deepEqual(observedOutputs, emptyOutputs());
});

// REQ-RUNACTION-26
// INV-EMBED-2
test("invalid acquisition documents fail before source reads and allocation", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "um-main-inputs-"));
  try {
    const source = path.join(workspace, "must-not-be-read");
    await writeFile(source, "private", { mode: 0o000 });
    let allocations = 0;
    const result = await executeAction(
      {
        GITHUB_WORKSPACE: workspace,
        GITHUB_OUTPUT: path.join(workspace, "github-output"),
        INPUT_WORKFLOW: "workflow.yaml",
        INPUT_INPUTS:
          '{"privateValue":{"kind":"json","path":"must-not-be-read","unknown":true}}',
      },
      {
        bootstrap: async () => ({
          executable: "/verified/um",
          cliDirectory: "/verified",
          environment: {},
        }),
        readInputs: readActionInputs,
        allocate: () => {
          allocations += 1;
          return unreachable<ExecutionAllocation>();
        },
        execute: () => unreachable<WorkflowProcessResult>(),
        readTerminal: () => unreachable<TerminalEnvelope>(),
        recover: async () => undefined,
        project: () => unreachable<ValidatedResultProjection>(),
        writeOutputs: async () => undefined,
        cleanup: async () => undefined,
      },
    );
    assert.equal(result.failure?.code, "input_invalid");
    assert.equal(allocations, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// REQ-RUNACTION-17
test("an unusable workspace or empty workflow fails before allocation and launch", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "um-main-workspace-"));
  try {
    const regularFile = path.join(workspace, "not-a-directory");
    await writeFile(regularFile, "");
    const environments: readonly NodeJS.ProcessEnv[] = [
      { INPUT_WORKFLOW: "workflow.yaml" },
      { GITHUB_WORKSPACE: "", INPUT_WORKFLOW: "workflow.yaml" },
      {
        GITHUB_WORKSPACE: "relative/workspace",
        INPUT_WORKFLOW: "workflow.yaml",
      },
      {
        GITHUB_WORKSPACE: path.join(workspace, "missing"),
        INPUT_WORKFLOW: "workflow.yaml",
      },
      { GITHUB_WORKSPACE: regularFile, INPUT_WORKFLOW: "workflow.yaml" },
      { GITHUB_WORKSPACE: workspace },
      { GITHUB_WORKSPACE: workspace, INPUT_WORKFLOW: "" },
    ];
    for (const environment of environments) {
      let allocations = 0;
      let launches = 0;
      const result = await executeAction(
        {
          ...environment,
          GITHUB_OUTPUT: path.join(workspace, "github-output"),
        },
        {
          bootstrap: async () => ({
            executable: "/verified/um",
            cliDirectory: "/verified",
            environment: {},
          }),
          readInputs: readActionInputs,
          allocate: () => {
            allocations += 1;
            return unreachable<ExecutionAllocation>();
          },
          execute: async () => {
            launches += 1;
            return unreachable<WorkflowProcessResult>();
          },
          readTerminal: () => unreachable<TerminalEnvelope>(),
          recover: async () => undefined,
          project: () => unreachable<ValidatedResultProjection>(),
          writeOutputs: async () => undefined,
          cleanup: async () => undefined,
        },
      );
      assert.equal(
        result.failure?.code,
        "input_invalid",
        JSON.stringify(environment),
      );
      assert.equal(allocations, 0);
      assert.equal(launches, 0);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

interface CommittedRun {
  readonly runDirectory: string;
  readonly artifactDirectory: string;
  readonly dependencies: ActionDependencies;
}

// Fakes for a run whose CLI commits a result under `root`; every phase
// succeeds unless a test overrides its dependency.
async function committedRun(
  root: string,
  outcome: ValidatedResultProjection["outcome"] = "succeeded",
  code = 0,
): Promise<CommittedRun> {
  const runDirectory = path.join(root, "run");
  const artifactDirectory = path.join(
    runDirectory,
    "attempts",
    "000001",
    "result",
  );
  await mkdir(path.join(artifactDirectory, "exports"), { recursive: true });
  await writeFile(path.join(artifactDirectory, "result.json"), "{}\n");
  const allocation: ExecutionAllocation = {
    parent: root,
    runDirectory,
    terminalPath: path.join(root, ".terminal.json"),
    inputFiles: [],
  };
  const actionInputs: ActionInputs = {
    workspace: root,
    workflow: path.join(root, "workflow.yaml"),
    sourceRoot: root,
    executionRoot: root,
    namedInputs: [],
    maximumParallel: "1",
    selectedExport: "selected",
  };
  const bootstrap: BootstrapResult = {
    executable: "/verified/um",
    cliDirectory: "/verified",
    environment: { PATH: "/verified:/caller" },
  };
  const terminal: TerminalEnvelope = {
    schemaVersion: 1,
    command: "um workflow run",
    outcome,
    exitStatus: code,
    runDirectory,
    attemptNumber: 1,
    resultDirectory: artifactDirectory,
    rootKeys: new Set([
      "schemaVersion",
      "command",
      "outcome",
      "exitStatus",
      "runDirectory",
      "attemptNumber",
      "resultDirectory",
      "result",
    ]),
  };
  return {
    runDirectory,
    artifactDirectory,
    dependencies: {
      bootstrap: async () => bootstrap,
      readInputs: async () => actionInputs,
      allocate: async () => allocation,
      execute: async () => ({
        code,
        signal: null,
        terminalPath: allocation.terminalPath,
        terminalBytes: 2,
        terminalOverflow: false,
      }),
      readTerminal: async () => terminal,
      recover: async () => undefined,
      project: async () => ({
        outcome,
        selected: { state: "unavailable" },
      }),
      writeOutputs: async () => undefined,
      cleanup: async () => undefined,
    },
  };
}

// REQ-RUNACTION-42, REQ-RUNACTION-44, REQ-RUNACTION-46, REQ-RUNACTION-48, REQ-RUNACTION-53, REQ-RUNACTION-56, REQ-RUNACTION-58, REQ-RUNACTION-59
// REQ-RUNACTION-76, REQ-RUNACTION-77
// INV-EMBED-5
test("result and process matrix preserves trustworthy outputs and failure precedence", async (t) => {
  const scenarios: readonly {
    name: string;
    outcome: "succeeded" | "failed" | "cancelled";
    code: number;
    projection?: SelectedProjection;
    projectionFailure?: AdapterError;
    cleanupFailure?: AdapterError;
    reported?: FailureCode;
    succeeds: boolean;
  }[] = [
    {
      name: "success",
      outcome: "succeeded",
      code: 0,
      projection: { state: "unavailable" },
      succeeds: true,
    },
    { name: "workflow failure", outcome: "failed", code: 1, succeeds: false },
    { name: "cancellation", outcome: "cancelled", code: 130, succeeds: false },
    {
      name: "independent CLI failure",
      outcome: "succeeded",
      code: 1,
      succeeds: false,
    },
    {
      name: "validation failure",
      outcome: "succeeded",
      code: 0,
      projectionFailure: new AdapterError("artifact_validation_failed"),
      succeeds: false,
    },
    {
      name: "oversized result",
      outcome: "succeeded",
      code: 0,
      projectionFailure: new AdapterError("result_projection_failed"),
      reported: "result_projection_failed",
      succeeds: false,
    },
    {
      name: "cleanup failure",
      outcome: "succeeded",
      code: 0,
      projection: { state: "unavailable" },
      cleanupFailure: new AdapterError("cleanup_failed"),
      reported: "cleanup_failed",
      succeeds: false,
    },
    {
      name: "oversized selected export",
      outcome: "succeeded",
      code: 0,
      projection: {
        state: "available",
        kind: "text",
        path: "/retained/carrier",
        failure: new AdapterError("result_projection_failed"),
      },
      succeeds: false,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "um-main-"));
      try {
        const {
          runDirectory,
          artifactDirectory,
          dependencies: fakes,
        } = await committedRun(root, scenario.outcome, scenario.code);
        let writes = 0;
        const dependencies: ActionDependencies = {
          ...fakes,
          project: async () => {
            if (scenario.projectionFailure) throw scenario.projectionFailure;
            return {
              outcome: scenario.outcome,
              ...(scenario.projection === undefined
                ? {}
                : { selected: scenario.projection }),
            };
          },
          writeOutputs: async () => {
            writes += 1;
          },
          cleanup: async () => {
            if (scenario.cleanupFailure) throw scenario.cleanupFailure;
          },
        };
        const result = await executeAction(
          { GITHUB_OUTPUT: path.join(root, "github-output") },
          dependencies,
        );
        assert.equal(writes, 1);
        assert.equal(result.failure === undefined, scenario.succeeds);
        if (scenario.reported) {
          assert.equal(result.failure?.code, scenario.reported);
        }
        assert.equal(result.outputs.outcome, scenario.outcome);
        assert.equal(result.outputs["run-directory"], runDirectory);
        assert.equal(result.outputs["artifact-set-path"], artifactDirectory);
        assert.equal(
          result.outputs["result-path"],
          path.join(artifactDirectory, "result.json"),
        );
        if (scenario.projection?.state === "unavailable") {
          assert.equal(result.outputs["export-state"], "unavailable");
        }
        if (scenario.projection?.path) {
          assert.equal(result.outputs["export-path"], scenario.projection.path);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

// REQ-RUNACTION-45, REQ-RUNACTION-47
// INV-EMBED-6
test("bare durable markers cannot expose terminal-less result outputs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "um-main-recovery-"));
  try {
    const runDirectory = path.join(root, "run");
    const artifactDirectory = path.join(
      runDirectory,
      "attempts",
      "000001",
      "result",
    );
    await mkdir(path.join(artifactDirectory, "exports"), { recursive: true });
    await writeFile(path.join(runDirectory, "run.json"), "{}\n");
    await writeFile(path.join(runDirectory, "state.json"), "{}\n");
    await writeFile(path.join(artifactDirectory, "result.json"), "{}\n");
    const allocation: ExecutionAllocation = {
      parent: root,
      runDirectory,
      terminalPath: path.join(root, ".terminal.json"),
      inputFiles: [],
    };
    let validations = 0;
    const result = await executeAction(
      { GITHUB_OUTPUT: path.join(root, "github-output") },
      {
        bootstrap: async () => ({
          executable: "/verified/um",
          cliDirectory: "/verified",
          environment: {},
        }),
        readInputs: async () => ({
          workspace: root,
          workflow: path.join(root, "workflow.yaml"),
          sourceRoot: root,
          executionRoot: root,
          namedInputs: [],
          maximumParallel: "1",
        }),
        allocate: async () => allocation,
        execute: async () => ({
          code: 1,
          signal: null,
          terminalPath: allocation.terminalPath,
          terminalBytes: 0,
          terminalOverflow: false,
        }),
        readTerminal: async () => {
          throw new AdapterError("terminal_result_invalid");
        },
        recover: (executable, recoveredAllocation, environment) =>
          recoverDurableRun(executable, recoveredAllocation, environment, {
            readStatus: async () => ({
              code: 1,
              signal: null,
              stdout: Buffer.from("{}\n"),
              stdoutOverflow: false,
              stderrOverflow: false,
            }),
          }),
        project: async (executable, identity) => {
          validations += 1;
          assert.equal(executable, "/verified/um");
          assert.equal(identity.outcome, undefined);
          assert.equal(identity.artifactDirectory, artifactDirectory);
          return { outcome: "failed" };
        },
        writeOutputs: async () => undefined,
        cleanup: async () => undefined,
      },
    );
    assert.equal(validations, 0);
    assert.equal(result.failure?.code, "terminal_result_invalid");
    assert.deepEqual(result.outputs, emptyOutputs());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// REQ-RUNACTION-47
// INV-EMBED-5
test("authenticated terminal-less recovery retains and validates its result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "um-main-recovery-"));
  try {
    const runDirectory = path.join(root, "run");
    const artifactDirectory = path.join(
      runDirectory,
      "attempts",
      "000001",
      "result",
    );
    await mkdir(path.join(artifactDirectory, "exports"), { recursive: true });
    await writeFile(path.join(artifactDirectory, "result.json"), "{}\n");
    const allocation: ExecutionAllocation = {
      parent: root,
      runDirectory,
      terminalPath: path.join(root, ".terminal.json"),
      inputFiles: [],
    };
    let validations = 0;
    const result = await executeAction(
      { GITHUB_OUTPUT: path.join(root, "github-output") },
      {
        bootstrap: async () => ({
          executable: "/verified/um",
          cliDirectory: "/verified",
          environment: {},
        }),
        readInputs: async () => ({
          workspace: root,
          workflow: path.join(root, "workflow.yaml"),
          sourceRoot: root,
          executionRoot: root,
          namedInputs: [],
          maximumParallel: "1",
        }),
        allocate: async () => allocation,
        execute: async () => ({
          code: 1,
          signal: null,
          terminalPath: allocation.terminalPath,
          terminalBytes: 0,
          terminalOverflow: false,
        }),
        readTerminal: async () => {
          throw new AdapterError("terminal_result_invalid");
        },
        recover: async () => ({
          runDirectory,
          result: {
            runDirectory,
            artifactDirectory,
            resultPath: path.join(artifactDirectory, "result.json"),
            outcome: "failed",
            attemptNumber: 1,
          },
        }),
        project: async (executable, identity) => {
          validations += 1;
          assert.equal(executable, "/verified/um");
          assert.equal(identity.outcome, "failed");
          assert.equal(identity.artifactDirectory, artifactDirectory);
          return { outcome: "failed" };
        },
        writeOutputs: async () => undefined,
        cleanup: async () => undefined,
      },
    );
    assert.equal(validations, 1);
    assert.equal(result.failure?.code, "terminal_result_invalid");
    assert.equal(result.outputs.outcome, "failed");
    assert.equal(result.outputs["run-directory"], runDirectory);
    assert.equal(result.outputs["artifact-set-path"], artifactDirectory);
    assert.equal(
      result.outputs["result-path"],
      path.join(artifactDirectory, "result.json"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// REQ-RUNACTION-79, REQ-RUNACTION-60, REQ-RUNACTION-61
// INV-EMBED-5
test("an unclassified error names its phase and class but never its text", async (t) => {
  const sentinel = "prompt attachment export credential provider-secret";
  const systemError = (code: string, errno: number) =>
    Object.assign(new Error(sentinel), { code, errno, syscall: "open" });
  const cases: readonly {
    name: string;
    dependencies: Partial<ActionDependencies>;
    diagnostic: FailureDiagnostic;
    line?: string;
  }[] = [
    {
      name: "bootstrap error",
      dependencies: {
        bootstrap: async () => {
          throw new Error(sentinel);
        },
      },
      diagnostic: { stage: "bootstrap", errorType: "error" },
    },
    {
      name: "terminal type error",
      dependencies: {
        readTerminal: async () => {
          throw new TypeError(sentinel);
        },
      },
      diagnostic: { stage: "terminal", errorType: "type_error" },
    },
    {
      name: "projection permission error",
      dependencies: {
        project: async () => {
          throw systemError("EACCES", -13);
        },
      },
      diagnostic: {
        stage: "projection",
        errorType: "system_error",
        ioError: "permission_denied",
      },
      line: "Useful Machinery Run failed [result_projection_failed] (stage=projection errorType=system_error ioError=permission_denied).",
    },
    {
      name: "output storage error",
      dependencies: {
        writeOutputs: async () => {
          throw systemError("ENOSPC", -28);
        },
      },
      diagnostic: {
        stage: "outputs",
        errorType: "system_error",
        ioError: "storage_full",
      },
    },
    {
      name: "cleanup non-error",
      dependencies: {
        cleanup: async () => {
          throw sentinel;
        },
      },
      diagnostic: { stage: "cleanup", errorType: "non_error" },
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "um-main-catch-all-"));
      try {
        const { dependencies } = await committedRun(root);
        const { failure } = await executeAction(
          { GITHUB_OUTPUT: path.join(root, "github-output") },
          { ...dependencies, ...scenario.dependencies },
        );
        assert.ok(failure);
        assert.equal(failure.code, "result_projection_failed");
        assert.deepEqual(failure.diagnostic, scenario.diagnostic);
        assert.equal(failure.message.includes(sentinel), false);
        if (scenario.line) assert.equal(failure.message, scenario.line);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

// REQ-RUNACTION-60, REQ-RUNACTION-61
test("adapter-authored failure is a stable structured fact", () => {
  const error = new AdapterError("artifact_validation_failed");
  assert.equal(
    error.message,
    "Useful Machinery Run failed [artifact_validation_failed].",
  );
  assert.equal(error.diagnostic, undefined);
  for (const prohibited of [
    "prompt",
    "token",
    "environment",
    "command output",
  ]) {
    assert.equal(error.message.toLowerCase().includes(prohibited), false);
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  for (const phase of [
    "allocation",
    "terminal",
    "recovery",
    "projection",
    "cleanup",
  ] as const) {
    // REQ-RUNACTION-41
    // INV-EMBED-8
    test(
      `cancellation during ${phase} cleans private inputs (${signal})`,
      { timeout: 5000 },
      async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "um-main-cancel-"));
        const before = [
          process.listenerCount("SIGINT"),
          process.listenerCount("SIGTERM"),
        ];
        let allocated: ExecutionAllocation | undefined;
        let cleanups = 0;
        let launches = 0;
        const cleaned = Promise.withResolvers<void>();
        const inputs: ActionInputs = {
          workspace: root,
          workflow: path.join(root, "workflow.yaml"),
          sourceRoot: root,
          executionRoot: root,
          maximumParallel: "1",
          namedInputs: [
            {
              name: "request",
              kind: "json",
              source: { kind: "inline", value: '{ "private": true }' },
            },
            {
              name: "text",
              kind: "text",
              source: { kind: "inline", value: "private text" },
            },
          ],
        };
        const interrupt = async () => {
          process.emit(signal);
          // Prove cleanup does not wait for blocked post-run processing to return.
          await cleaned.promise;
        };
        try {
          const result = await executeAction(
            { RUNNER_TEMP: root },
            {
              bootstrap: async () => ({
                executable: "/verified/cli",
                cliDirectory: "/verified",
                environment: {},
              }),
              readInputs: async () => inputs,
              allocate: async (temp, named) => {
                allocated = await allocateExecution(temp, named);
                if (phase === "allocation") process.emit(signal);
                return allocated;
              },
              execute: async (_exe, _inputs, allocation) => {
                launches += 1;
                await mkdir(
                  path.join(allocation.runDirectory, "attempts/000001/result"),
                  { recursive: true },
                );
                await writeFile(
                  path.join(
                    allocation.runDirectory,
                    "attempts/000001/result/result.json",
                  ),
                  "{}\n",
                );
                return {
                  code: 0,
                  signal: null,
                  terminalPath: allocation.terminalPath,
                  terminalBytes: 2,
                  terminalOverflow: false,
                };
              },
              readTerminal: async () => {
                if (phase === "terminal") await interrupt();
                if (phase === "recovery")
                  throw new AdapterError("terminal_result_invalid");
                assert.ok(allocated);
                return {
                  schemaVersion: 1,
                  command: "um workflow run",
                  outcome: "succeeded",
                  exitStatus: 0,
                  runDirectory: allocated.runDirectory,
                  attemptNumber: 1,
                  resultDirectory: path.join(
                    allocated.runDirectory,
                    "attempts/000001/result",
                  ),
                  rootKeys: new Set([
                    "schemaVersion",
                    "command",
                    "outcome",
                    "exitStatus",
                    "runDirectory",
                    "attemptNumber",
                    "resultDirectory",
                    "result",
                  ]),
                };
              },
              recover: async () => {
                if (phase === "recovery") await interrupt();
                return undefined;
              },
              project: async () => {
                if (phase === "projection") await interrupt();
                return { outcome: "succeeded" };
              },
              writeOutputs: async () => undefined,
              cleanup: async (allocation) => {
                cleanups += 1;
                if (phase === "cleanup") process.emit(signal);
                await cleanupExecution(allocation);
                cleaned.resolve();
              },
            },
          );
          assert.ok(result.failure);
          assert.equal(cleanups, 1);
          assert.ok(allocated);
          for (const input of allocated.inputFiles)
            await assert.rejects(access(input.path));
          await assert.rejects(access(allocated.terminalPath));
          if (phase === "allocation") {
            assert.equal(launches, 0);
            await assert.rejects(access(allocated.parent));
          } else {
            await access(
              path.join(
                allocated.runDirectory,
                "attempts/000001/result/result.json",
              ),
            );
          }
          assert.deepEqual(
            [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")],
            before,
          );
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    );
  }
}

// REQ-RUNACTION-72
test("a CLI launch failure starts no run and exposes no result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "um-main-launch-"));
  try {
    const allocation = await allocateExecution(root, []);
    let observedOutputs: ActionOutputs | undefined;
    const result = await executeAction(
      { GITHUB_OUTPUT: path.join(root, "github-output") },
      {
        bootstrap: async () => ({
          executable: "/verified/um",
          cliDirectory: "/verified",
          environment: {},
        }),
        readInputs: async () => ({
          workspace: root,
          workflow: path.join(root, "workflow.yaml"),
          sourceRoot: root,
          executionRoot: root,
          namedInputs: [],
          maximumParallel: "1",
          selectedExport: "selected",
        }),
        allocate: async () => allocation,
        execute: async () => {
          throw new AdapterError("child_launch_failed");
        },
        readTerminal: () => unreachable<TerminalEnvelope>(),
        recover: (executable, allocated, environment) =>
          recoverDurableRun(executable, allocated, environment, {
            readStatus: () => unreachable(),
          }),
        project: () => unreachable<ValidatedResultProjection>(),
        writeOutputs: async (_file, outputs) => {
          observedOutputs = { ...outputs };
        },
        cleanup: cleanupExecution,
      },
    );
    assert.equal(result.failure?.code, "child_launch_failed");
    assert.deepEqual(observedOutputs, emptyOutputs());
    await assert.rejects(access(allocation.parent));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
