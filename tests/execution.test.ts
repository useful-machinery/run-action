import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import {
  allocateExecution,
  cleanupExecution,
  runWorkflow,
  workflowArguments,
  type ExecutionDependencies,
} from "../src/execution.ts";
import { AdapterError, type FailureCode } from "../src/errors.ts";
import type { ActionInputs } from "../src/inputs.ts";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killedWith: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.killedWith.push(signal);
    return true;
  }
}

function inputs(workspace: string): ActionInputs {
  return {
    workspace,
    workflow: path.join(workspace, "workflow.yaml"),
    sourceRoot: workspace,
    executionRoot: workspace,
    namedInputs: [
      { name: "emptyItems", kind: "attachments", items: [] },
      {
        name: "fileValue",
        kind: "file",
        mediaType: "application/octet-stream",
        path: path.join(workspace, "data.bin"),
      },
      {
        name: "inlineJson",
        kind: "json",
        source: {
          kind: "inline",
          value: '[1.00e+2, {"escaped":"\\u0061"}]',
        },
      },
      {
        name: "inlineText",
        kind: "text",
        source: { kind: "inline", value: "private text\r\n" },
      },
      {
        name: "orderedItems",
        kind: "attachments",
        items: [
          { mediaType: "image/png", path: path.join(workspace, "one.png") },
          { mediaType: "image/png", path: path.join(workspace, "one.png") },
        ],
      },
      {
        name: "pathJson",
        kind: "json",
        source: { kind: "path", path: path.join(workspace, "-") },
      },
      {
        name: "pathText",
        kind: "text",
        source: { kind: "path", path: path.join(workspace, "notes.txt") },
      },
    ],
    maximumParallel: "0007",
    selectedExport: "report",
  };
}

async function withTemporary(
  callback: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "um-execution-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// REQ-RUNACTION-19, REQ-RUNACTION-23, REQ-RUNACTION-27, REQ-RUNACTION-28, REQ-RUNACTION-29, REQ-RUNACTION-30, REQ-RUNACTION-32, REQ-RUNACTION-33, REQ-RUNACTION-34, REQ-RUNACTION-35, REQ-RUNACTION-36, REQ-RUNACTION-40, REQ-RUNACTION-50
test("one shell-free child drains streams, spools JSON, and forwards one signal", async () => {
  await withTemporary(async (directory) => {
    const workspace = path.join(directory, "workspace");
    const runnerTemp = path.join(directory, "runner-temp");
    await mkdir(workspace);
    await mkdir(runnerTemp);
    const actionInputs = inputs(workspace);
    const allocation = await allocateExecution(
      runnerTemp,
      actionInputs.namedInputs,
    );
    assert.equal((await lstat(allocation.parent)).mode & 0o7777, 0o700);
    assert.deepEqual(
      allocation.inputFiles.map(({ name, kind }) => ({ name, kind })),
      [
        { name: "inlineJson", kind: "json" },
        { name: "inlineText", kind: "text" },
      ],
    );
    assert.equal(
      await readFile(allocation.inputFiles[0]!.path, "utf8"),
      '[1.00e+2, {"escaped":"\\u0061"}]',
    );
    assert.equal(
      await readFile(allocation.inputFiles[1]!.path, "utf8"),
      "private text\r\n",
    );
    for (const input of allocation.inputFiles) {
      assert.equal((await lstat(input.path)).mode & 0o7777, 0o600);
    }
    await assert.rejects(access(allocation.runDirectory));

    const child = new FakeChild();
    const signals = new EventEmitter();
    const presentationStream = new PassThrough();
    let presentationBytes = "";
    presentationStream.on(
      "data",
      (chunk) => (presentationBytes += chunk.toString()),
    );
    let launches = 0;
    let markSpawned: (() => void) | undefined;
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    let observed:
      | {
          executable: string;
          arguments_: readonly string[];
          options: Parameters<ExecutionDependencies["spawn"]>[2];
        }
      | undefined;
    const dependencies: ExecutionDependencies = {
      spawn: (executable, arguments_, options) => {
        launches += 1;
        observed = { executable, arguments_, options };
        markSpawned?.();
        return child as never;
      },
      signals,
      presentationStream,
      randomBytes: () => Buffer.alloc(32, 0xef),
      maximumTerminalBytes: 1024,
    };

    const running = runWorkflow(
      "/verified/cli/um",
      actionInputs,
      allocation,
      { PATH: "/verified/cli:/caller/bin", ORDINARY: "retained" },
      dependencies,
    );
    await spawned;
    signals.emit("SIGINT");
    signals.emit("SIGTERM");
    child.stderr.write("::set-output name=hostile::value\n");
    child.stderr.end("presentation complete\n");
    child.stdout.end('{"schemaVersion":1}\n');
    child.emit("close", 130, null);
    const result = await running;

    assert.equal(launches, 1);
    assert.deepEqual(child.killedWith, ["SIGINT"]);
    assert.equal(result.signalForwarded, "SIGINT");
    assert.equal(result.code, 130);
    assert.equal(result.signal, null);
    assert.equal(result.terminalOverflow, false);
    assert.equal(
      await readFile(result.terminalPath, "utf8"),
      '{"schemaVersion":1}\n',
    );
    assert.equal(
      presentationBytes,
      `::stop-commands::um_${"ef".repeat(32)}\n::set-output name=hostile::value\npresentation complete\n::um_${"ef".repeat(32)}::\n`,
    );
    assert.equal(observed?.executable, "/verified/cli/um");
    const inlineJsonPath = allocation.inputFiles[0]!.path;
    const inlineTextPath = allocation.inputFiles[1]!.path;
    const expectedArguments = [
      "workflow",
      "run",
      "--source-root",
      workspace,
      "--execution-root",
      workspace,
      "--run-dir",
      allocation.runDirectory,
      "--max-parallel",
      "0007",
      "--json",
      "--input-attachments-empty",
      "emptyItems",
      "--input-file",
      "fileValue",
      "application/octet-stream",
      path.join(workspace, "data.bin"),
      "--input-json-file",
      "inlineJson",
      inlineJsonPath,
      "--input-text-file",
      "inlineText",
      inlineTextPath,
      "--input-attachment",
      "orderedItems",
      "image/png",
      path.join(workspace, "one.png"),
      "--input-attachment",
      "orderedItems",
      "image/png",
      path.join(workspace, "one.png"),
      "--input-json-file",
      "pathJson",
      path.join(workspace, "-"),
      "--input-text-file",
      "pathText",
      path.join(workspace, "notes.txt"),
      path.join(workspace, "workflow.yaml"),
    ];
    assert.deepEqual(observed?.arguments_, expectedArguments);
    assert.deepEqual(
      workflowArguments(actionInputs, allocation),
      expectedArguments,
    );
    assert.equal(
      expectedArguments.some((argument) => argument.includes("private text")),
      false,
    );
    assert.equal(
      expectedArguments.some((argument) => argument.includes("1.00e+2")),
      false,
    );
    assert.equal(observed?.options.shell, false);
    assert.deepEqual(observed?.options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(observed?.options.cwd, workspace);
    assert.deepEqual(observed?.options.env, {
      PATH: "/verified/cli:/caller/bin",
      ORDINARY: "retained",
    });

    await mkdir(allocation.runDirectory);
    await writeFile(path.join(allocation.runDirectory, "durable"), "retained");
    await cleanupExecution(allocation);
    for (const input of allocation.inputFiles) {
      await assert.rejects(access(input.path));
    }
    await assert.rejects(access(allocation.terminalPath));
    assert.equal(
      await readFile(path.join(allocation.runDirectory, "durable"), "utf8"),
      "retained",
    );
  });
});

// REQ-RUNACTION-40
// INV-EMBED-8
test("cancellation during launch preparation reaches the child only once", async () => {
  await withTemporary(async (directory) => {
    const actionInputs = inputs(directory);
    const allocation = await allocateExecution(
      directory,
      actionInputs.namedInputs,
    );
    const child = new FakeChild();
    const signals = new EventEmitter();
    const cancellation = new AbortController();
    const presentationStream = new PassThrough();
    presentationStream.resume();
    const result = await runWorkflow(
      "/verified/cli",
      actionInputs,
      allocation,
      {},
      {
        spawn: () => {
          // Cancellation reaches the Action before runWorkflow can register its
          // child handlers. A later second signal must not duplicate forwarding.
          cancellation.abort("SIGTERM");
          queueMicrotask(() => {
            signals.emit("SIGINT");
            child.stdout.end();
            child.stderr.end();
            child.emit("close", null, "SIGTERM");
          });
          return child as never;
        },
        signals,
        presentationStream,
        randomBytes: () => Buffer.alloc(32, 0xef),
        maximumTerminalBytes: 1024,
      },
      cancellation.signal,
    );
    assert.deepEqual(child.killedWith, ["SIGTERM"]);
    assert.equal(result.signalForwarded, "SIGTERM");
    signals.emit("SIGTERM");
    assert.deepEqual(child.killedWith, ["SIGTERM"]);
    await cleanupExecution(allocation);
  });
});

test("a symlinked runner temp retains the CLI's normalized run identity", async () => {
  await withTemporary(async (directory) => {
    const physicalTemp = path.join(directory, "physical");
    const runnerTemp = path.join(directory, "runner-temp");
    await mkdir(physicalTemp);
    await symlink(physicalTemp, runnerTemp, "dir");

    const allocation = await allocateExecution(runnerTemp, []);

    assert.equal(
      allocation.runDirectory,
      path.join(await realpath(allocation.parent), "run"),
      "the identity retained by the Action must match the normalized path returned by the CLI",
    );
  });
});

// REQ-RUNACTION-33
test("an occupied reserved run path is rejected before child launch", async () => {
  await withTemporary(async (directory) => {
    const workspace = path.join(directory, "workspace");
    const runnerTemp = path.join(directory, "runner-temp");
    await mkdir(workspace);
    await mkdir(runnerTemp);
    const allocation = await allocateExecution(runnerTemp, []);
    await mkdir(allocation.runDirectory);
    let launches = 0;
    await assert.rejects(
      runWorkflow(
        "/verified/cli",
        inputs(workspace),
        allocation,
        {},
        {
          spawn: () => {
            launches += 1;
            return new FakeChild() as never;
          },
          signals: new EventEmitter(),
          presentationStream: new PassThrough(),
          randomBytes: () => Buffer.alloc(32, 1),
          maximumTerminalBytes: 4,
        },
      ),
      /allocation_failed/u,
    );
    assert.equal(launches, 0);
  });
});

// REQ-RUNACTION-36
test("terminal spool is bounded while stdout continues to EOF", async () => {
  await withTemporary(async (directory) => {
    const workspace = path.join(directory, "workspace");
    const runnerTemp = path.join(directory, "runner-temp");
    await mkdir(workspace);
    await mkdir(runnerTemp);
    const allocation = await allocateExecution(runnerTemp, []);
    const child = new FakeChild();
    const signals = new EventEmitter();
    let markSpawned: (() => void) | undefined;
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    const dependencies: ExecutionDependencies = {
      spawn: () => {
        markSpawned?.();
        return child as never;
      },
      signals,
      presentationStream: new PassThrough(),
      randomBytes: () => Buffer.alloc(32, 1),
      maximumTerminalBytes: 4,
    };
    const running = runWorkflow(
      "/verified/cli",
      { ...inputs(workspace), namedInputs: [] },
      allocation,
      {},
      dependencies,
    );
    await spawned;
    child.stdout.end("abcdefghij");
    child.stderr.end();
    child.emit("close", 1, null);
    const result = await running;
    assert.equal(result.terminalBytes, 10);
    assert.equal(result.terminalOverflow, true);
    assert.equal(await readFile(result.terminalPath, "utf8"), "abcd");
    await cleanupExecution(allocation);
    await assert.rejects(access(allocation.parent));
  });
});

function failsWith(code: FailureCode): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof AdapterError && error.code === code;
}

// A log that accepts its first `accepted` writes and fails every later one.
function failingLog(accepted: number): Writable {
  let writes = 0;
  const log = new Writable({
    write(_chunk, _encoding, callback) {
      writes += 1;
      callback(writes > accepted ? new Error("log closed") : null);
    },
  });
  // The guard observes the failure through the write callback; the stream's
  // later error event must not escape as an uncaught test failure.
  log.on("error", () => undefined);
  return log;
}

// REQ-RUNACTION-72
test("a CLI that cannot be started fails as child_launch_failed", async (t) => {
  for (const [name, launch] of [
    [
      "spawn throws",
      (): never => {
        throw new Error("spawn EACCES");
      },
    ],
    [
      "child reports an error",
      () => {
        const child = new FakeChild();
        queueMicrotask(() => {
          child.emit("error", new Error("spawn ENOENT"));
          child.stdout.end();
          child.stderr.end();
          child.emit("close", -2, null);
        });
        return child as never;
      },
    ],
  ] as const) {
    await t.test(name, async () => {
      await withTemporary(async (directory) => {
        const allocation = await allocateExecution(directory, []);
        const presentationStream = new PassThrough();
        presentationStream.resume();
        await assert.rejects(
          runWorkflow(
            "/verified/cli",
            { ...inputs(directory), namedInputs: [] },
            allocation,
            {},
            {
              spawn: launch,
              signals: new EventEmitter(),
              presentationStream,
              randomBytes: () => Buffer.alloc(32, 2),
              maximumTerminalBytes: 1024,
            },
          ),
          failsWith("child_launch_failed"),
        );
        assert.equal(await readFile(allocation.terminalPath, "utf8"), "");
        await cleanupExecution(allocation);
      });
    });
  }
});

// REQ-RUNACTION-73
test("an unwritable result spool, log, or stop marker fails as child_output_failed", async (t) => {
  const cases: readonly {
    name: string;
    prepare: (terminalPath: string) => Promise<void>;
    log: () => NodeJS.WritableStream;
    launches: number;
  }[] = [
    {
      name: "result spool",
      prepare: (terminalPath) => chmod(terminalPath, 0o644),
      log: () => new PassThrough().resume(),
      launches: 0,
    },
    {
      name: "stop-commands start marker",
      prepare: async () => undefined,
      log: () => failingLog(0),
      launches: 0,
    },
    {
      name: "stop-commands end marker",
      prepare: async () => undefined,
      log: () => failingLog(1),
      launches: 1,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      await withTemporary(async (directory) => {
        const allocation = await allocateExecution(directory, []);
        await scenario.prepare(allocation.terminalPath);
        let launches = 0;
        await assert.rejects(
          runWorkflow(
            "/verified/cli",
            { ...inputs(directory), namedInputs: [] },
            allocation,
            {},
            {
              spawn: () => {
                launches += 1;
                const child = new FakeChild();
                queueMicrotask(() => {
                  child.stdout.end("{}");
                  child.stderr.end();
                  child.emit("close", 0, null);
                });
                return child as never;
              },
              signals: new EventEmitter(),
              presentationStream: scenario.log(),
              randomBytes: () => Buffer.alloc(32, 3),
              maximumTerminalBytes: 1024,
            },
          ),
          failsWith("child_output_failed"),
        );
        assert.equal(launches, scenario.launches);
        await cleanupExecution(allocation);
      });
    });
  }
});

// REQ-RUNACTION-76
test("an Action file that cannot be removed fails cleanup without touching the run", async () => {
  await withTemporary(async (directory) => {
    const allocation = await allocateExecution(directory, []);
    await mkdir(path.join(allocation.runDirectory, "attempts"), {
      recursive: true,
    });
    await rm(allocation.terminalPath);
    await mkdir(allocation.terminalPath);
    await writeFile(path.join(allocation.terminalPath, "occupied"), "");
    await assert.rejects(
      cleanupExecution(allocation),
      failsWith("cleanup_failed"),
    );
    assert.ok((await lstat(allocation.runDirectory)).isDirectory());
    assert.ok(
      (
        await lstat(path.join(allocation.runDirectory, "attempts"))
      ).isDirectory(),
    );
  });
});
