// `useful workflow run status --json` of `useful` 0.78.0 (aarch64-apple-darwin) for a
// run interrupted by SIGINT while its one step was running, as captured: every member
// is the CLI's, except the run directory and execution root, which name the capture's
// host paths and are replaced by the arguments, and the record's owner, the capturing
// login, which is replaced by `runner`, the login of GitHub's hosted runners.
export function pinnedStatusDocument(
  runDirectory: string,
  executionRoot: string,
) {
  return {
    schemaVersion: 1,
    command: "useful workflow run status",
    outcome: "status",
    exitStatus: 0,
    runDirectory: runDirectory,
    run: {
      createdAt: "2026-11-18T04:43:27.608878Z",
      gitBaseline: {
        reason: "not_work_tree",
        status: "unavailable",
      },
      localRunId: "d8c0b681-e7b6-4250-b4df-b825c4cffb95",
      schemaVersion: 1,
      workflowDigest: {
        algorithm: "sha256",
        value:
          "e9a0f415cb20e91fbcd61f1b1851111cca75d9a724d2158921158d5511108637",
      },
      workflowManifestDigest: {
        algorithm: "sha256",
        value:
          "99d5ad32fd251861111003a3ff66fdfe29a980d6d06f436b32a6f100437bade8",
      },
    },
    state: {
      attempts: [
        {
          attemptId: "7be4caca-9388-455d-a4bf-e91ae0d2e96e",
          attemptNumber: 1,
          cancellation: {
            forceStopDeadline: "2026-11-18T04:43:37.775195Z",
            reason: "user_request",
            requestedAt: "2026-11-18T04:43:27.780441Z",
            workflowConfirmed: false,
          },
          createdAt: "2026-11-18T04:43:27.608878Z",
          definition: {
            digest: {
              algorithm: "sha256",
              value:
                "e9a0f415cb20e91fbcd61f1b1851111cca75d9a724d2158921158d5511108637",
            },
            locator: {
              kind: "run",
            },
            manifestDigest: {
              algorithm: "sha256",
              value:
                "99d5ad32fd251861111003a3ff66fdfe29a980d6d06f436b32a6f100437bade8",
            },
          },
          executionRoot: executionRoot,
          forceAbort: null,
          owner: {
            executionHost: {
              kind: "host_boot",
              value: "8a2a47d2-9336-4e9f-8d03-29cd417a1371",
            },
            ownerNonce: "e6939c5b-3226-4f14-bee3-f32a1e96b353",
          },
          processGuards: [
            {
              actionId: 1,
              executionHost: {
                kind: "host_boot",
                value: "8a2a47d2-9336-4e9f-8d03-29cd417a1371",
              },
              guardId: "31097c9d-cc0d-4751-9c47-1364c3704545",
              liveness: {
                kind: "leader_start_identity",
                value: "1794977007:704364",
              },
              nodeRole: "step",
              processGroupId: 29934,
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
            lastTransitionSequence: 7,
            outstandingActions: [],
            steps: [
              {
                detail: {
                  code: "interrupted",
                  phase: "execution",
                },
                failurePolicy: "required",
                id: "wait",
                outputs: [],
                role: "step",
                startedAt: "2026-11-18T04:43:27.679434Z",
                state: "failed",
              },
            ],
          },
          result: {
            relativeDirectory: "attempts/000001/result",
            status: "published",
          },
          settledAt: "2026-11-18T04:43:27.840598Z",
          settlementSnapshot: {
            algorithm: "git_worktree_sha256_v1",
            settledBy: "engine",
            unavailable: "not_work_tree",
          },
          startedAt: "2026-11-18T04:43:27.679434Z",
          state: "workflow_failed",
          trigger: "initial",
        },
      ],
      currentAttemptNumber: 1,
      diagnostics: [],
      localRunId: "d8c0b681-e7b6-4250-b4df-b825c4cffb95",
      revision: 8,
      schemaVersion: 1,
    },
    record: {
      attempts: 1,
      definition: null,
      edges: {},
      external: {},
      id: "run_01m7pff1ygbxt8zw9yk4pv9tjj",
      outcome: "failed",
      owner: "runner",
      parent: null,
      position: [],
      predecessor: null,
      revision: null,
      schemaVersion: 1,
      startedAt: "2026-11-18T04:43:27.568176Z",
      state: "exited",
      subject: null,
      successor: null,
      tree: "sha256:e33b6db7177e229d6fde200776b5be09753095e0425735dbfda58ead3e89945f",
      workflow: "workflow.yaml",
    },
    wait: null,
    recovery: {
      status: "settled",
    },
    retry: {
      eligible: true,
    },
    continuation: {
      eligible: true,
      requestAdmission: "not_evaluated",
    },
    workspaceModified: "unknown",
  };
}
