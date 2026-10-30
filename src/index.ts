import { asAdapterError } from "./errors.ts";
import { runMain } from "./main.ts";

void runMain().catch((error: unknown) => {
  process.stderr.write(`${asAdapterError(error, "entry").message}\n`);
  process.exitCode = 1;
});
