import { spawn } from "node:child_process";
import path from "node:path";

import { AdapterError, type FailureCode } from "./errors.ts";

export interface CapturedCommand {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stdoutOverflow: boolean;
  readonly stderrOverflow: boolean;
}

// The `command` member of a document the installed CLI prints for `words`: the
// name of the executable the installation names, then the words
// (REQ-RUNACTION-87).
export function cliCommand(executable: string, words: string): string {
  return `${path.basename(executable)} ${words}`;
}

// Which spelling of the run's status and of artifact validation the installed
// CLI has: `current` has `workflow run show` and `workflow run artifact
// validate`; `earlier`, which a selected or pinned release may still be, has
// `workflow run status` and `artifact validate` (REQ-RUNACTION-78).
export type CliTree = "current" | "earlier";

// Answers for the command that asks, failing with that command's code when
// the installed CLI gives no answer.
export type CliTreeProbe = (failureCode: FailureCode) => Promise<CliTree>;

const TREE_PROBE = ["workflow", "run", "artifact", "validate", "--help"];

// Asks the installed CLI, once for every command that asks the returned probe,
// whether it has `workflow run artifact validate`: exit 0 says it does and
// exit 2, a usage error, that it does not; any other ending answers nothing.
// `workflow run show` cannot tell the trees apart, since the earlier tree has
// a `show` that prints another document; a version number is never read. The
// probe's output is drained unread.
export function askCliTree(
  executable: string,
  environment: NodeJS.ProcessEnv,
): CliTreeProbe {
  let answer: Promise<CliTree | undefined> | undefined;
  return async (failureCode) => {
    answer ??= captureCommand(
      executable,
      TREE_PROBE,
      environment,
      0,
      failureCode,
    ).then(
      ({ code, signal }) =>
        signal !== null
          ? undefined
          : code === 0
            ? "current"
            : code === 2
              ? "earlier"
              : undefined,
      () => undefined,
    );
    const tree = await answer;
    if (tree === undefined) throw new AdapterError(failureCode);
    return tree;
  };
}

export async function captureCommand(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  maximumBytes: number,
  failureCode: FailureCode,
): Promise<CapturedCommand> {
  const child = spawn(executable, [...arguments_], {
    env: environment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const collect = async (
    stream: NodeJS.ReadableStream,
    retain: boolean,
  ): Promise<{ bytes: Buffer; overflow: boolean }> => {
    const chunks: Buffer[] = [];
    let observed = 0;
    let overflow = false;
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value)
        ? value
        : Buffer.from(
            typeof value === "string" ? value : (value as Uint8Array),
          );
      const remaining = maximumBytes - observed;
      const selected = chunk.subarray(0, Math.max(remaining, 0));
      if (retain && selected.length > 0) chunks.push(selected);
      observed += selected.length;
      if (selected.length < chunk.length) overflow = true;
    }
    return { bytes: Buffer.concat(chunks), overflow };
  };

  const stdoutPromise = collect(child.stdout, true);
  const stderrPromise = collect(child.stderr, false);
  const completion = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).catch(() => {
    throw new AdapterError(failureCode);
  });
  const [stdout, stderr] = await Promise.all([
    stdoutPromise,
    stderrPromise,
  ]).catch(() => {
    throw new AdapterError(failureCode);
  });
  return {
    ...completion,
    stdout: stdout.bytes,
    stdoutOverflow: stdout.overflow,
    stderrOverflow: stderr.overflow,
  };
}
