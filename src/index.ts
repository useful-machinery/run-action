import { runMain } from "./main.ts";

void runMain().catch(() => {
  process.stderr.write(
    "Useful Machinery Run failed [result_projection_failed].\n",
  );
  process.exitCode = 1;
});
