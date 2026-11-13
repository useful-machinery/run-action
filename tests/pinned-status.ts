// `um workflow status --json` of `um` 0.72.1 for a run cancelled by SIGINT
// while its one step was running, as captured: every member is the CLI's, but
// the run directory and execution root, which name the capture's host paths,
// are replaced by the arguments.
export function pinnedStatusDocument(
  runDirectory: string,
  executionRoot: string,
) {
  return {
    schemaVersion: 1,
    command: "um workflow status",
    outcome: "status",
    exitStatus: 0,
    runDirectory,
    run: {
      createdAt: "2026-11-12T19:39:10.546826887Z",
      gitBaseline: { reason: "not_work_tree", status: "unavailable" },
      localRunId: "b521e229-0a9a-4a7c-b327-cb799a1b8734",
      schemaVersion: 1,
      workflowDigest: {
        algorithm: "sha256",
        value:
          "edd4542bd53446ce75052ba967a19fd0c6dcc2fd13476555f3d2c810c9fc5f31",
      },
      workflowManifestDigest: {
        algorithm: "sha256",
        value:
          "11de0bbc90de686baaa1e1ba667fa0c8e9046663f47acde63f76d77345278964",
      },
    },
    state: {
      attempts: [
        {
          attemptId: "039d9e53-e845-4079-87a9-943d86612a91",
          attemptNumber: 1,
          cancellation: {
            forceStopDeadline: "2026-11-12T19:39:20.74147216Z",
            reason: "user_request",
            requestedAt: "2026-11-12T19:39:10.742383697Z",
            workflowConfirmed: true,
          },
          createdAt: "2026-11-12T19:39:10.546826887Z",
          definition: {
            digest: {
              algorithm: "sha256",
              value:
                "edd4542bd53446ce75052ba967a19fd0c6dcc2fd13476555f3d2c810c9fc5f31",
            },
            locator: { kind: "run" },
            manifestDigest: {
              algorithm: "sha256",
              value:
                "11de0bbc90de686baaa1e1ba667fa0c8e9046663f47acde63f76d77345278964",
            },
          },
          executionRoot,
          forceAbort: null,
          owner: {
            executionHost: {
              kind: "host_boot",
              value: "76c2e0c1-3753-4d15-9123-acc5a7d9fa9d",
            },
            ownerNonce: "0e5934d6-ea67-4d86-9439-26fc2823f7c3",
          },
          processGuards: [
            {
              actionId: 1,
              executionHost: {
                kind: "host_boot",
                value: "76c2e0c1-3753-4d15-9123-acc5a7d9fa9d",
              },
              guardId: "73456189-78fa-4d29-9eb3-e7e20a1e112c",
              liveness: { kind: "leader_start_identity", value: "10090186" },
              nodeRole: "step",
              processGroupId: 1174035,
              state: "quiesced",
              stepId: "wait",
            },
          ],
          progress: {
            acceptedOccurrenceOrdinal: 4,
            accounting: {
              discardedDiagnosticBytes: 0,
              inputTokens: 0,
              maximumInvocations: 1,
              observedInvocations: 0,
              outputTokens: 0,
              retainedDiagnosticBytes: 0,
              settledInvocations: 0,
            },
            lastTransitionSequence: 6,
            outstandingActions: [],
            steps: [
              {
                detail: { code: "user_request" },
                failurePolicy: "required",
                id: "wait",
                outputs: [],
                role: "step",
                state: "cancelled",
              },
            ],
          },
          result: {
            relativeDirectory: "attempts/000001/result",
            status: "published",
          },
          settledAt: "2026-11-12T19:39:10.762901427Z",
          settlementSnapshot: {
            algorithm: "git_worktree_sha256_v1",
            settledBy: "engine",
            unavailable: "not_work_tree",
          },
          startedAt: "2026-11-12T19:39:10.564728028Z",
          state: "cancelled",
          trigger: "initial",
        },
      ],
      currentAttemptNumber: 1,
      diagnostics: [],
      localRunId: "b521e229-0a9a-4a7c-b327-cb799a1b8734",
      revision: 8,
      schemaVersion: 1,
    },
    recovery: { status: "settled" },
    retry: { eligible: true },
    continuation: { eligible: true, requestAdmission: "not_evaluated" },
    workspaceModified: "unknown",
  };
}
