# forkit

Declarative maintenance for downstream forks. Forkit tracks an upstream branch,
tag, or release; reapplies selected contribution branches; advances generated
fork branches; and optionally publishes multi-architecture containers.

## Configuration

Each managed repository has one
`repositories/<owner>/<repository>/forkit.yaml`. A target branch declares its
source, ordered contributions, conflict policy, and optional container.

```yaml
fork: codgician/litellm

upstream:
  repository: BerriAI/litellm
  branch: litellm_internal_staging

branches:
  my:
    track:
      releases:
        prerelease: false
        match: '^v[0-9]+\.[0-9]+\.[0-9]+$'
    contributions:
      - litellm_configurable_copilot_headers
      - litellm_update_github_copilot_models
    on_conflict: ai
    container:
      image: ghcr.io/codgician/litellm
      platforms: [linux/amd64, linux/arm64]
      smoke:
        entrypoint: litellm
        command: ["--version"]
```

Tracking can select an upstream branch directly, the newest matching GitHub
release, or the newest matching tag. Omitting `container` makes branch
maintenance the only output:

```yaml
fork: codgician/proxmox-nixos

upstream:
  repository: SaumonNet/proxmox-nixos
  branch: main

branches:
  my:
    track:
      branch: main
    contributions: [nixos-26.05]
    on_conflict: ai
```

`upstream.branch` is the development base used when a contribution has no pull
request. When a pull request exists, its actual base branch determines the
delta.

Upstreams may also be HTTPS Git repositories on other hosts. Downstream
repositories always live on GitHub. Use `upstream.git` instead of
`upstream.repository`; branch and tag tracking use Git, while `releases` and
`when-merged` cleanup require a GitHub upstream:

```yaml
fork: codgician/redrix-ec
upstream:
  git: https://chromium.googlesource.com/chromiumos/platform/ec
  branch: ec-legacy
branches:
  ec-legacy:
    track: { branch: ec-legacy }
  my:
    track: { branch: ec-legacy }
    contributions:
      - branch: patches/mkbp-host-events
        base: b5f7b64a1d8f86b82f8e1ea6290d97a2dedea12d
        cleanup: manual
    on_conflict: fail
```

Object contributions declare a branch, an optional full base commit SHA, and
`cleanup: manual` (default) or `when-merged`. An explicit base must be an
ancestor of the contribution head and defines exactly its delta, including
when patches are stacked. Without it, manual patches use the merge-base with
`upstream.branch`. String contributions retain automatic PR lookup and cleanup
for GitHub upstreams, and use manual cleanup for other Git hosts. Manual patches
never query PRs; an empty application fails for inspection instead of deleting
the configuration entry. Patch inputs cannot also be generated target branches.

Keep durable edits on the patch branches. `my` is generated and may be rewritten
as upstream advances. Tags use semantic version ordering when possible, then
Git creator date (tagger date for annotated tags, commit date for lightweight
tags), with tag names breaking ties.

## Validation

Any target may declare a validation command, independently of container builds:

```yaml
validation:
  command: [bash, -c, 'exec "$FORKIT_CONFIG_DIR/validate.sh"']
  timeout_minutes: 60
```

The command runs after composition in a disposable archive of the exact output
commit, including on unchanged targets. It has no checkout Git metadata and
does not inherit GitHub or AI credentials. Build-host adaptations cannot change
the published tree. This is process/environment isolation, not a filesystem or
network sandbox; validation scripts are trusted configuration.

`FORKIT_CONFIG_DIR` points to the manifest's directory. `FORKIT_REPOSITORY`,
`FORKIT_BRANCH`, `FORKIT_COMMIT`, and `FORKIT_SOURCE_COMMIT` identify the input.
Command arguments are passed directly; use an explicit shell when needed.
A failed command prevents publication of that target. The default timeout is
30 minutes. Redrix's manifest includes a pinned Nix toolchain, a firmware build,
native lid/MKBP tests, and the backlight regression test.

## Guarantees

- **Contributions are deltas, not merges.** Forkit applies only `base..head`, so
  unrelated commits carried by a contribution branch do not leak into the
  generated branch.
- **Composition is all-or-nothing.** A missing or conflicting contribution
  fails the target instead of silently publishing an incomplete result. Other
  targets can still advance; an unpatched mirror is independent of patch failures.
- **Merged contributions remain until shipped.** A contribution is skipped
  only after its pull request is merged and the tracked source contains that
  merge. After successful publication, the pipeline commits a manifest update
  removing it from that target's `contributions` list. Targets tracking older
  sources retain it. A deleted PR head is supported once shipped; a branch
  with new commits beyond the merged PR is retained.
- **Inputs are deterministic.** A fingerprint of the source and contribution
  heads makes identical runs reuse the existing generated commit.
- **Updates are race-safe.** Every branch push is protected by a lease against
  the tip observed during composition.
- **Versions do not regress by publication date.** Parseable release and tag
  names are ordered semantically.

Forkit reads contribution branches but never updates them.

## Conflict resolution

`on_conflict` defaults to `fail`. Setting it to `ai` permits the pi-based
resolver to repair genuine Git conflicts on the generated branch.

The resolver receives only `read`, `grep`, `ls`, and `edit`. Filesystem access
is confined to the disposable worktree, Git metadata is blocked, and edits are
limited to files Git reports as conflicted. A resolution is committed only if
Git reports no unmerged entries, conflict markers, out-of-scope edits, or diff
errors.

Generated commit messages carry durable source and input provenance. Resolver
trajectories are encrypted before upload and are treated as debugging telemetry,
not provenance.

## Workflow

The scheduled workflow discovers every manifest and creates one isolated job
graph per repository:

1. **Compose** resolves sources and contributions once and bundles the exact
   generated commits after validation. Targets sharing a source use the same
   observed upstream commit. Target failures are recorded in the artifact.
2. **Build** runs only when a changed target declares a container. Each platform
   uses a native Ubuntu runner; there is no QEMU.
3. **Publish** advances generated branches and, when configured, combines native
   image digests into one OCI manifest and runs the smoke command.
4. **Clean up configuration** removes shipped contributions from the manifest
   on the workflow's branch, even when the generated branch is unchanged. The
   publisher App needs contents write access to this repository as well as the
   managed forks. Cleanup refuses to overwrite a manifest edited since compose;
   rerun against the updated configuration in that case.

A failure in one repository does not cancel another. Publication is serialized
per repository so concurrent runs cannot race its branches or tags. Successful
targets publish even when another target fails composition, validation, or a
container build. The final result still fails the workflow to report the problem.
Cleanup includes only successfully published targets. Push events
exercise composition and builds in dry-run mode; scheduled and explicit runs
may publish.

## Local development

Direnv loads the same locked Nix shell used by GitHub Actions. JavaScript and pi
dependencies remain pinned by `bun.lock`.

```bash
direnv allow
bun install --frozen-lockfile
```

Workflow operations are project-local pi commands and can run interactively or
headlessly:

```bash
export FORKIT_REPOSITORY=codgician/litellm
export GITHUB_TOKEN=...
export FORKIT_DRY_RUN=1

pi --no-session -p /forkit-plan
pi --no-session -p /forkit-compose
FORKIT_PLATFORM=linux/amd64 pi --no-session -p /forkit-build
```

`/forkit-publish` consumes `source/` and, for container targets, completed
`digests/`; CI invokes it only after the required native builds.

| Variable | Purpose |
| --- | --- |
| `FORKIT_REPOSITORY` | Managed `owner/repository`; optional only when planning all repositories. |
| `FORKIT_PLATFORM` | Platform required by `/forkit-build`. |
| `GITHUB_TOKEN` | GitHub access for compose and publish. |
| `DENDRO_API_KEY` | AI resolver credential; without it, conflicts fail. |
| `TRAJECTORY_ZIP_PASSWD` | Password for encrypted resolver trajectories. |
| `FORKIT_DRY_RUN` | `1` disables branch and registry publication. |
| `FORKIT_CONFIG_REPOSITORY`, `FORKIT_CONFIG_BRANCH` | Together enable manifest cleanup commits after publish; CI sets these to the workflow repository and branch. Dry runs never commit cleanup. |
| `FORKIT_ALLOW_PARTIAL` | CI sets `1` so compose emits successful target artifacts despite target failures; the final workflow job reports failure. Local compose exits nonzero by default. |

To add a fork, add its manifest. Discovery is automatic; there is no central
registry or workflow file to edit.
