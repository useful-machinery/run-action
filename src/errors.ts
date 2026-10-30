export type FailureCode =
  | "allocation_failed"
  | "artifact_validation_failed"
  | "bootstrap_download_failed"
  | "bootstrap_integrity_failed"
  | "bootstrap_platform_unsupported"
  | "bootstrap_version_failed"
  | "child_launch_failed"
  | "child_output_failed"
  | "cleanup_failed"
  | "github_file_command_failed"
  | "input_invalid"
  | "result_identity_invalid"
  | "result_projection_failed"
  | "terminal_result_invalid"
  | "workflow_failed";

// The phase an unclassified error escaped (REQ-RUNACTION-79).
export type FailureStage =
  | "allocation"
  | "bootstrap"
  | "cleanup"
  | "entry"
  | "execution"
  | "identity"
  | "inputs"
  | "outputs"
  | "projection"
  | "recovery"
  | "terminal";

export type FailureErrorType =
  | "error"
  | "non_error"
  | "range_error"
  | "syntax_error"
  | "system_error"
  | "type_error";

export type FailureIoError =
  | "already_exists"
  | "not_found"
  | "other"
  | "permission_denied"
  | "read_only_filesystem"
  | "storage_full";

// Safe facts about an unclassified error: slugs chosen here, never its text.
export interface FailureDiagnostic {
  readonly stage: FailureStage;
  readonly errorType: FailureErrorType;
  readonly ioError?: FailureIoError;
}

function failureLine(
  code: FailureCode,
  diagnostic?: FailureDiagnostic,
): string {
  if (diagnostic === undefined) return `Useful Machinery Run failed [${code}].`;
  const members = [
    `stage=${diagnostic.stage}`,
    `errorType=${diagnostic.errorType}`,
    ...(diagnostic.ioError === undefined
      ? []
      : [`ioError=${diagnostic.ioError}`]),
  ];
  return `Useful Machinery Run failed [${code}] (${members.join(" ")}).`;
}

export class AdapterError extends Error {
  readonly code: FailureCode;
  readonly diagnostic?: FailureDiagnostic;

  constructor(code: FailureCode, diagnostic?: FailureDiagnostic) {
    super(failureLine(code, diagnostic));
    this.name = "AdapterError";
    this.code = code;
    if (diagnostic !== undefined) this.diagnostic = diagnostic;
  }
}

const IO_ERRORS: ReadonlyMap<string, FailureIoError> = new Map([
  ["ENOENT", "not_found"],
  ["EACCES", "permission_denied"],
  ["EPERM", "permission_denied"],
  ["EEXIST", "already_exists"],
  ["EROFS", "read_only_filesystem"],
  ["ENOSPC", "storage_full"],
  ["EDQUOT", "storage_full"],
]);

// Classifies by identity only: the error's class and, for a Node system
// error (a string `code` and `syscall`), its code. Never reads `message`.
function classify(
  error: unknown,
): Pick<FailureDiagnostic, "errorType" | "ioError"> {
  if (!(error instanceof Error)) return { errorType: "non_error" };
  const { code, syscall } = error as { code?: unknown; syscall?: unknown };
  if (typeof code === "string" && typeof syscall === "string") {
    return {
      errorType: "system_error",
      ioError: IO_ERRORS.get(code) ?? "other",
    };
  }
  if (error instanceof TypeError) return { errorType: "type_error" };
  if (error instanceof RangeError) return { errorType: "range_error" };
  if (error instanceof SyntaxError) return { errorType: "syntax_error" };
  return { errorType: "error" };
}

export function asAdapterError(
  error: unknown,
  stage: FailureStage,
): AdapterError {
  return error instanceof AdapterError
    ? error
    : new AdapterError("result_projection_failed", {
        stage,
        ...classify(error),
      });
}
