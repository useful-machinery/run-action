import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// The probe the Action runs to learn the installed CLI's command tree.
export const TREE_PROBE = ["workflow", "run", "artifact", "validate", "--help"];

// Writes an executable that prints `payload` exactly on stdout for any other
// arguments, so a test can drive the Action's real capture of a CLI command.
// It ends the tree probe with `probeExit`: 0 as a CLI that has `workflow run
// artifact validate` does, 2 (a usage error) as an earlier CLI does. It
// records each argument vector it receives, the probe's included, for
// `fakeCliCalls`.
export async function fakeCli(
  directory: string,
  name: string,
  payload: Buffer,
  probeExit = 0,
): Promise<string> {
  const payloadPath = path.join(directory, `${name}.stdout`);
  const callsPath = path.join(directory, `${name}.calls`);
  const executable = path.join(directory, name);
  await writeFile(payloadPath, payload);
  await writeFile(callsPath, "");
  await writeFile(
    executable,
    `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(argv) + "\\n");
if (JSON.stringify(argv) === ${JSON.stringify(JSON.stringify(TREE_PROBE))}) process.exit(${probeExit});
process.stdout.write(fs.readFileSync(${JSON.stringify(payloadPath)}));
`,
  );
  await chmod(executable, 0o755);
  return executable;
}

// The argument vectors a `fakeCli` executable received, in order.
export async function fakeCliCalls(executable: string): Promise<string[][]> {
  const calls = await readFile(`${executable}.calls`, "utf8");
  return calls
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as string[]);
}

// Serializes `document` and pads it with trailing JSON whitespace to exactly `size` bytes.
export function paddedJson(document: unknown, size: number): Buffer {
  const json = Buffer.from(`${JSON.stringify(document)}\n`);
  if (json.length > size) throw new Error("document exceeds the padded size");
  return Buffer.concat([json, Buffer.alloc(size - json.length, 0x20)]);
}
