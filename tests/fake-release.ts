import { createHash } from "node:crypto";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import tarStream from "tar-stream";

import { PINNED_RELEASE } from "../src/release.ts";

export type TarMutation = "traversal" | "link" | "inventory" | "mode";

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Builds a gzipped release archive rooted at `root` with the canonical
// four-entry layout around the executable `executable`, or that layout broken
// by `mutation`, and returns the inventory of the canonical layout.
export async function archiveBytes(
  root: string,
  executable: string,
  mutation?: TarMutation,
): Promise<{
  bytes: Buffer;
  inventory: {
    path: string;
    type: "directory" | "file";
    mode: number;
    size: number;
  }[];
}> {
  const pack = tarStream.pack();
  const chunks: Buffer[] = [];
  pack.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const ended = once(pack, "end");
  const license = Buffer.from("license\n");
  const readme = Buffer.from("readme\n");
  const program = Buffer.from("fake executable\n");
  pack.entry({ name: `${root}/`, type: "directory", mode: 0o755, size: 0 });
  pack.entry({ name: `${root}/LICENSE`, type: "file", mode: 0o644 }, license);
  if (mutation === "link") {
    pack.entry({
      name: `${root}/README.md`,
      type: "symlink",
      linkname: "/outside",
      mode: 0o644,
      size: 0,
    });
  } else {
    pack.entry(
      {
        name:
          mutation === "traversal"
            ? `${root}/../README.md`
            : `${root}/README.md`,
        type: "file",
        mode: 0o644,
      },
      readme,
    );
  }
  pack.entry(
    {
      name: `${root}/${executable}`,
      type: "file",
      mode: mutation === "mode" ? 0o700 : 0o755,
    },
    program,
  );
  if (mutation === "inventory") {
    pack.entry(
      { name: `${root}/extra`, type: "file", mode: 0o644 },
      Buffer.from("x"),
    );
  }
  pack.finalize();
  await ended;
  return {
    bytes: gzipSync(Buffer.concat(chunks)),
    inventory: [
      { path: root, type: "directory", mode: 0o755, size: 0 },
      {
        path: `${root}/LICENSE`,
        type: "file",
        mode: 0o644,
        size: license.length,
      },
      {
        path: `${root}/README.md`,
        type: "file",
        mode: 0o644,
        size: readme.length,
      },
      {
        path: `${root}/${executable}`,
        type: "file",
        mode: 0o755,
        size: program.length,
      },
    ],
  };
}

// The executable an archive's inventory names: the base name of its one file
// with mode 0755.
export function inventoryExecutable(
  inventory: readonly { path: string; type: string; mode: number }[],
): string {
  const executables = inventory.filter(
    (entry) => entry.type === "file" && entry.mode === 0o755,
  );
  if (executables.length !== 1) {
    throw new Error(`inventory names ${executables.length} executables`);
  }
  return executables[0]!.path.split("/").at(-1)!;
}

// The executable the pinned evidence names, which replays of the pinned
// release's captured output run as.
export const PINNED_EXECUTABLE = inventoryExecutable(
  PINNED_RELEASE.archives["x86_64-unknown-linux-gnu"].inventory,
);
