import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

// Writes an executable that ignores its arguments and prints `payload` exactly
// on stdout, so a test can drive the Action's real capture of a CLI command.
export async function fakeCli(
  directory: string,
  name: string,
  payload: Buffer,
): Promise<string> {
  const payloadPath = path.join(directory, `${name}.stdout`);
  const executable = path.join(directory, name);
  await writeFile(payloadPath, payload);
  await writeFile(
    executable,
    `#!${process.execPath}\nprocess.stdout.write(require("node:fs").readFileSync(${JSON.stringify(payloadPath)}));\n`,
  );
  await chmod(executable, 0o755);
  return executable;
}

// Serializes `document` and pads it with trailing JSON whitespace to exactly `size` bytes.
export function paddedJson(document: unknown, size: number): Buffer {
  const json = Buffer.from(`${JSON.stringify(document)}\n`);
  if (json.length > size) throw new Error("document exceeds the padded size");
  return Buffer.concat([json, Buffer.alloc(size - json.length, 0x20)]);
}
