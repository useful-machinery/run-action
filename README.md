# Useful Machinery Run Action

The implementation pins the checksum-verified `useful` v0.81.1 release and runs `useful`
0.78.0 or later. This README and both executable examples still select public mirror
revision `b9de88cc55fb9301697eccb72e42030a49ec495d`, the last revision for which
[source, all three native behavior jobs and the pinned-release jobs passed](https://github.com/useful-machinery/run-action/actions/runs/42555199928);
it carries the earlier `um` 0.72.1 release and its `um-version` input. They move to a
revision that carries this pin once its jobs pass on the public mirror.

Run a checked-in Useful Machinery workflow inside a GitHub Actions job—without sending the
run to Useful Machinery.

Useful Machinery workflows describe a directed graph of command and AI-agent steps. This
Action lets GitHub provide the runner, trigger, and job environment while Useful Machinery
coordinates the workflow, captures its declared outputs, and produces one validated
local result.

## Why use it?

Use the Action when you want to:

- keep multi-step automation in a reusable, reviewable workflow instead of a large
  GitHub Actions job;
- combine ordinary repository commands with Pi, Claude Code, or Codex agent steps;
- get a structured outcome and a complete Portable Artifact Set when a terminal result
  commits, including for failed or cancelled workflows;
- pass one declared text, JSON, file, or Git-branch export to later steps; and
- run with an exact, verified Useful Machinery CLI without installing the CLI separately or
  creating a Useful Machinery account.

A typical job checks out a repository, installs any agent harness used by the workflow,
runs this Action, and then chooses what to do with the result. Uploading artifacts,
pushing branches, and opening pull requests remain separate, explicitly credentialed
steps.

## What the Action owns

The Action:

1. downloads the exact Useful Machinery CLI release pinned by the selected Action revision,
   or the published release its `useful-version` input selects;
2. verifies the release checksum and CLI build identity;
3. runs exactly one fresh local Workflow V1 invocation;
4. validates the complete Portable Artifact Set; and
5. exposes trustworthy outcome, path, and optional selected-export outputs to later
   steps in the same job.

The caller still owns:

- repository checkout and source preparation;
- every command-line tool used by command steps;
- installation and configuration of any selected agent harness;
- provider, application, Git, and GitHub credentials made available to the workflow;
- retry and recovery policy; and
- artifact upload, cross-job persistence, branch publication, and pull-request creation.

Command-only workflows do not require an agent harness. The Action itself requests no
GitHub token, Useful Machinery credential, harness-provider credential, or application credential.

## Before you start

The job must provide an existing `GITHUB_WORKSPACE`, a writable `RUNNER_TEMP`, the
workflow source, and an existing execution directory. Supported runners are:

- Linux x86-64;
- Linux ARM64; and
- macOS ARM64.

Windows and macOS x86-64 are not supported by V1.

## Run one workflow

This command-only example pins the verified named-input public mirror revision whose
source and all three native runner jobs passed. The caller owns checkout; the Action owns only the one
local workflow invocation and leaves its paths available to later steps in the same job.

```yaml
permissions:
  contents: read

steps:
  - name: Check out caller repository
    uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
    with:
      persist-credentials: false
  - name: Run checked-in Useful Machinery workflow
    id: useful
    uses: useful-machinery/run-action@b9de88cc55fb9301697eccb72e42030a49ec495d
    with:
      workflow: .useful/workflows/ci.yaml
  - name: Consume the retained result in the same job
    if: ${{ always() && steps.useful.outputs.result-path != '' }}
    env:
      ARTIFACT_SET_PATH: ${{ steps.useful.outputs.artifact-set-path }}
      RESULT_PATH: ${{ steps.useful.outputs.result-path }}
      WORKFLOW_OUTCOME: ${{ steps.useful.outputs.outcome }}
    run: |
      set -euo pipefail
      test -d "$ARTIFACT_SET_PATH"
      test -f "$RESULT_PATH"
      useful artifact validate --json "$ARTIFACT_SET_PATH" >/dev/null
      printf 'workflow outcome: %s\n' "$WORKFLOW_OUTCOME"
```

The last step runs `useful artifact validate`, the spelling of the release this revision
pins. From the first release that moves it under `workflow run`, the command is
`useful workflow run artifact validate`, and its `--json` document names that command. The
Action itself asks the installed CLI which of the two it has and runs that spelling, for its
own validation and for its read of the run's status.

The source tree also contains a working
[PR conflict resolver](examples/resolve-pr-conflicts/README.md) and advanced
[nightly Sentry repair composition](examples/nightly-sentry-repair/README.md). The latter
adds agent-produced JSON discovery, a bounded GitHub matrix, and publisher
failure-isolation verification. Both executable examples use named `request` inputs and
pin the same verified Action mirror: JSON for Sentry and Text for the conflict resolver.
Neither sets a CLI version, so each installs the `um` 0.72.1 release that revision bundles,
and their harness pins sit inside that CLI's admitted ranges. That revision cannot follow
new CLI releases; [Moving from an earlier revision](#moving-from-an-earlier-revision)
describes the change.

Keep each example's reference, acquisition form, workflow, and harness requirements
paired when upgrading. V1 provides no moving `v1`, `latest`, or semantic-version tag; do not
improvise with `main`, another branch or tag, an abbreviation, a placeholder, or a
Useful Machinery monorepo commit.

## Choosing the CLI version

The optional `useful-version` input chooses the `useful` release the step installs:

- omit it, or leave it empty, to install the release this Action revision pins (v0.81.1
  here); the CLI is reproducible for each Action revision and is the one the revision
  was tested with;
- set an exact published version such as `0.78.0` to install that release; the CLI stays
  the same across Action revisions; or
- set `latest` to install the newest published release; upgrades arrive automatically,
  and a step may run a CLI this Action revision was not tested with.

```yaml
with:
  workflow: .useful/workflows/ci.yaml
  useful-version: latest
```

Any other value, such as `1.2`, `v1.2.3` or `Latest`, fails naming `input_invalid` before
anything is downloaded. A version that is not published fails naming
`bootstrap_release_unavailable`. A release the input selects has no pin in this revision:
the Action checks it against that release's own `SHA256SUMS` over TLS to `github.com`,
checks the archive's layout, and probes `useful version --json` for the selected version and
a build identity. Any failure fails the step; the Action never falls back to the pinned
release, another version, or a `useful` already on `PATH`. The step's `useful-version` output and
one log line name the version installed, how it was chosen (`bundled`, `requested` or
`latest`) and its build identity. The step runs, and puts on `PATH` for later steps, the
executable its installation names: `useful` for a release the input selects, and for the
pinned release the executable that `release-evidence.json` records in its archive.

This revision runs `useful` 0.78.0 or later. An earlier release names its archives
`um-<version>-<target>.tar.gz` and has an earlier command line, so selecting one fails
naming `bootstrap_integrity_failed`.

## Moving from an earlier revision

Revisions published before the CLI was renamed from `um` to `useful` install `um` and run
its earlier command line. On those revisions an exact version up to 0.77.0, or no version,
keeps working, but `latest` now selects a `useful` release they cannot install or run. To
move a step to this revision:

1. Replace the `uses:` revision with this revision's full public mirror SHA.
2. Rename the `um-version` input to `useful-version`, keeping its value; an exact version
   must be 0.78.0 or later.
3. Change later steps that run the CLI from `PATH`, such as `um artifact validate`, to
   `useful`.
4. Keep `workflow` inside `source-root`: this revision refuses a workflow file outside it,
   naming `input_invalid`.
5. A job cancelled during a run now reports `outcome` `failed`: `useful` records the
   interruption as a failed step rather than a cancelled run.

## Inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `workflow` | required | Workflow file to run, inside `source-root`. Relative paths resolve from `GITHUB_WORKSPACE`. |
| `source-root` | `GITHUB_WORKSPACE` | Complete source boundary containing the workflow and its static files. |
| `execution-root` | `GITHUB_WORKSPACE` | Existing caller-owned directory in which commands and agents run. |
| `inputs` | absent | Closed JSON acquisition map for named Text, JSON, File, and attachment-collection values. |
| `max-parallel` | `1` | Maximum number of workflow nodes to run concurrently, from 1 through 256. |
| `export` | absent | Exact declared workflow export to bridge to selected-export outputs. |
| `useful-version` | absent | CLI release to install: omit for the pinned v0.81.1, `latest`, or an exact `MAJOR.MINOR.PATCH`. |

Absent or empty `inputs`, and the document `{}`, all supply the empty named map. A
nonempty value is one JSON object keyed by declared Workflow V1 input names. Each member
uses exactly one closed form:

```json
{
  "instructions": { "kind": "text", "value": "exact inline text" },
  "request": { "kind": "json", "path": "request.json" },
  "bundle": {
    "kind": "file",
    "mediaType": "application/zip",
    "path": "bundle.zip"
  },
  "evidence": {
    "kind": "attachments",
    "items": [
      { "mediaType": "text/plain", "path": "notes.txt" },
      { "mediaType": "image/png", "path": "screenshot.png" }
    ]
  },
  "optionalEvidence": { "kind": "attachments", "items": [] }
}
```

Text and JSON each accept either `value` or a nonempty `path`. JSON `value` may be any
JSON value, including `null`; inline Text may be empty. File requires a nonempty
`mediaType` and `path`. Attachment items retain their array order, while an empty array
supplies a present empty collection. Unknown fields, duplicate members, unknown kinds,
and mixed value/path forms are rejected.

Every relative workflow, source, execution, and acquisition path resolves from
`GITHUB_WORKSPACE`. A path equal to `-` means the ordinary workspace file named `-`, not
standard input. Inline Text and exact lexical inline JSON bytes travel through temporary
owner-private files and never through argv or stdin; those files are removed after the
CLI stops. The Action visits names in unsigned UTF-8 order and leaves kind, interface,
media-type, schema, and acquisition bounds to the pinned CLI. It does not infer a
repository or workflow-directory boundary.

## Outputs

| Output | Purpose |
| --- | --- |
| `useful-version` | The `useful` version verified and installed; empty when bootstrap did not complete. |
| `outcome` | Committed workflow outcome: `succeeded`, `failed`, or `cancelled`. |
| `run-directory` | Durable local run directory when a trustworthy run identity is available. |
| `artifact-set-path` | Complete validated Portable Artifact Set path. |
| `result-path` | Committed `result.json` path inside the Artifact Set. |
| `export-state` | `available` or `unavailable` when `export` selected an exact declared export. |
| `export-kind` | Selected export kind: `file`, `text`, `json`, or `git_branch`. |
| `export-path` | Local carrier path for an available selected export, when present. |
| `export-value` | Inline bytes for eligible text or JSON exports up to 65,536 bytes. |

Paths are available only to later steps on the same runner. They are not URLs and do not
survive the job unless a later step uploads or publishes them. The presence of a path
does not mean the workflow succeeded; use the Action step conclusion or `outcome`.

The complete Artifact Set is the authoritative handoff. Selecting `export` only projects
one declared export into convenient GitHub step outputs; it does not filter or modify the
Artifact Set.

## Security and trust boundary

Local workflow execution is not a sandbox. Commands and agent harnesses run as the job
user and can use the files, environment, processes, credentials, and network access that
the job makes available. Do not expose a credential to the Action step unless the whole
workflow may exercise that authority.

Before launching the workflow, the Action removes every variable whose name starts with
`INPUT_` or `USEFUL_RUN_ACTION_`, and GitHub's file-command handles `GITHUB_OUTPUT`,
`GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_STATE` and `GITHUB_STEP_SUMMARY`, from the child
environment. It also prevents workflow log lines
from being interpreted as GitHub workflow commands. Other caller-provided environment
values remain available under the local Workflow V1 environment policy.

## Public distribution

The Action is distributed from
[`useful-machinery/run-action`](https://github.com/useful-machinery/run-action).
Pin `uses:` to a full 40-character commit SHA from that repository. Branches and moving
references do not provide the immutable selection required by V1.

Each Action revision carries its exact CLI release contract in
[`release-evidence.json`](release-evidence.json). That pinned release is the default:
runtime bootstrap consumes the closed record directly and verifies the downloaded release
against it. The `useful-version` input selects another published release instead, verified
against that release's own checksum list, and looks up `latest` only when asked to. The
Action never falls back to an ambient CLI.

## Recovery

If a selected immutable Action revision is defective, choose a previously tested full
mirror SHA for future jobs. A published revision remains public: do not delete it,
force-move a reference, replace the SHA with a moving branch or tag, or claim that
selecting an older SHA erases the defective bytes. Publish any correction as a reviewed,
fully tested fast-forward revision.

## Development

Use Node 24.16 and npm 11.13. Install the committed lockfile and run the complete package
check:

```sh
npm ci
npm run check
```

Regenerate the committed GitHub runtime and third-party license inventory with:

```sh
npm run build
```

`npm run check` formats, type-checks, lints, and tests the authoritative TypeScript, then
rebuilds the bundle and license inventory in clean temporary directories and requires
byte equality with `dist/index.cjs` and `dist/licenses.txt`.
