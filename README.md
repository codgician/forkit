# forkit

Declarative fork maintenance. Tracks upstream releases, applies your own
contributions on top, and publishes containers — without hand-maintaining a
patch stack.

## What it does

For each managed fork, `forkit.yaml` declares what every branch means:

```yaml
fork: codgician/litellm

upstream:
  repository: BerriAI/litellm
  branch: litellm_internal_staging

branches:
  main:
    track:
      branch: main

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
```

Every hour that produces:

- `main` set to upstream's own `main`, unpatched, never built.
- `my` rebuilt from the newest stable release with both contributions applied.
- `ghcr.io/codgician/litellm:my` plus an immutable
  `ghcr.io/codgician/litellm:v1.94.0-my.<sha>`.

## Design

**Contributions apply as deltas, not merges.** A contribution branch is based on
upstream development and usually carries unrelated commits. Merging it into a
release would drag those along, so forkit applies only `base..head`, where
`base` is the merge-base with the branch its pull request targets.

**Composition is all-or-nothing.** A contribution that cannot be applied fails
the branch. Publishing an image that silently lacks a patch is worse than
publishing nothing.

**Contributions are dropped only once upstream ships them** — the pull request
merged *and* the tracked release contains that merge. Dropping at merge time
would lose the change for the weeks until the next release.

**Forkit never writes to your contribution branches.** It reads them. Keeping
an open pull request current is a judgement call about someone else's review,
which belongs to you, not to an hourly job.

**Every push is lease-protected** against the tip observed at the start of a run.

**Releases are ordered by semantic version, not publication date.** GitHub
returns releases newest-first by date, so a backport published after a newer
line would otherwise downgrade a branch.

**One GraphQL request per repository.** REST enumeration cost ~60 requests for a
repository the size of litellm and silently missed pull requests beyond its page
limit.

## Conflict resolution

When git reports a genuine conflict — and only then — `on_conflict: ai` hands
the worktree to a resolver built on the pi SDK.

Declared per branch and defaulting to `fail`, so a branch opts in rather than
inheriting it. Resolutions land only on generated branches, never on anything
attached to an upstream review.

It runs with `read`, `grep`, `ls`, and `edit`. `bash` and `write` are withheld:
the checkout has push-capable remotes, and resolving a conflict needs neither.

Any resolution must pass every gate before it is committed:

| Gate | Rejects |
| --- | --- |
| `unmerged-entries` | an index git still considers unmerged |
| `conflict-markers` | leftover `<<<<<<<` / `=======` / `>>>>>>>` |
| `out-of-scope-edits` | changes to files outside the conflicted set |
| `diff-check` | whitespace damage |

The gates check the tree, never the model's account of what it did.

A clean merge never invokes the model. Neither does a failing test, a failed
build, or an API error.

## Records

The durable record of a resolution is its commit message, which carries
notification-free provenance trailers. Pull request numbers are deliberately
excluded: pushing a generated commit must never create activity on an upstream
review.

```
Forkit-Contribution: litellm_configurable_copilot_headers
Forkit-Source-Base: 2f2e1e75...
Forkit-Source-Head: 6bfcea21...
Forkit-Applied-To: v1.94.0
Forkit-Input: sha256:...
```

Resolver trajectories are development telemetry for tuning the harness, not
provenance. They are encrypted with AES-256 and encrypted headers, uploaded as
workflow artifacts, and never written to logs or the job summary — both are
public on a public repository.

## Running it

```bash
bun install
GITHUB_TOKEN=$(gh auth token) FORKIT_DRY_RUN=1 bun run src/main.ts
```

`FORKIT_DRY_RUN=1` composes and builds without pushing anything.

| Variable | Purpose |
| --- | --- |
| `GITHUB_TOKEN` | Required. GraphQL and pushes. |
| `DENDRO_API_KEY` | Resolver credential. Unset means conflicts fail. |
| `TRAJECTORY_ZIP_PASSWD` | Encrypts trajectory archives. |
| `FORKIT_DRY_RUN` | `1` to skip every push. |

## Adding a fork

Add `repositories/<owner>/<repo>/forkit.yaml`. Repositories are discovered by
glob; there is no central registry, and nothing else needs editing.

Each fork gets an isolated workflow. Within it, compose runs exactly once and
hands the resulting commit to one native runner per architecture. The final job
combines their digests into a single OCI manifest before moving the branch.

For the built-in platforms, both runners use Ubuntu 24.04:

| platform | runner |
| --- | --- |
| `linux/amd64` | `ubuntu-24.04` |
| `linux/arm64` | `ubuntu-24.04-arm` |

There is no QEMU and no architecture in the image name. A client pulls the
entry matching its own platform from the same tag.

A failure in one fork does not cancel another. Runs are serialised per fork at
publication, where two runs would otherwise race on its branches and tags.

Anything a project needs beyond git is declared in its own file — platforms,
Dockerfile, and the command that proves the image runs:

```yaml
    container:
      image: ghcr.io/codgician/litellm
      dockerfile: Dockerfile
      platforms: [linux/amd64, linux/arm64]
      smoke:
        entrypoint: litellm
        command: ["--version"]
```
