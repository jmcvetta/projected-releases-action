# Projected Releases for release-please

[![Test](https://github.com/jmcvetta/projected-releases-action/actions/workflows/test.yml/badge.svg)](https://github.com/jmcvetta/projected-releases-action/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/release/jmcvetta/projected-releases-action)](https://github.com/jmcvetta/projected-releases-action/releases)
[![License](https://img.shields.io/github/license/jmcvetta/projected-releases-action)](LICENSE)

A GitHub Action that comments on a pull request with what
[release-please](https://github.com/googleapis/release-please) will do when
it merges: which packages release, at what version, and under which tag. The
numbers come from release-please itself, bundled into the action.

---

### Projected releases

| Package | Path | Files | Current | Without this PR | Projected | Tag |
| --- | --- | --- | --- | --- | --- | --- |
| `acme-api` | `api` | 3 | 2.4.1 | 2.4.2 | **2.5.0** | `acme-api@v2.5.0` |

_1 other package unchanged: `acme-ui`._

<details><summary>Changelog preview</summary>

#### `acme-api`

### Features

* verify the webhook signature header ([#41](https://github.com/acme/acme/pull/41)) ([9f3c1ab](https://github.com/acme/acme/commit/9f3c1ab))

</details>

<details><summary>Matched files</summary>

`acme-api` matched `api/src/webhook.ts`, `api/src/verify.ts`,
`api/test/webhook.test.ts`.

</details>

<sub>Projected for `9f3c1ab` · re-rendered 2026-09-04 11:20 UTC</sub>

---

The comment is updated as the title or the branch changes. When nothing
releases, it says so.

## Quick start

Copy to `.github/workflows/projected-releases.yml`:

```yaml
name: Projected releases
on:
  pull_request:
    types: [opened, reopened, synchronize, edited]
concurrency:
  group: projected-releases-${{ github.event.pull_request.number }}
  cancel-in-progress: true
permissions:
  contents: read
  pull-requests: write
jobs:
  preview:
    runs-on: ubuntu-latest
    if: ${{ !startsWith(github.event.pull_request.head.ref, 'release-please--') }}
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: jmcvetta/projected-releases-action@v0
```

That is all a repository with `release-please-config.json` and
`.release-please-manifest.json` needs. Keep `edited` in the trigger list, so
a title fixed after review re-renders the comment. The `concurrency:` block
matters because a title edit and a push often land close together, and it
keeps the last-written comment describing the current head. The `if:` skips
release-please's own release pull requests, which always release something
regardless of what their title says.

`fetch-depth: 0` buys three things: the changed-file diff runs from the merge
base, each commit's file list is read locally instead of one API request
per commit, and a merge or rebase projection can read the branch's commits at
all. A shallow clone falls back to the API for the first two and drops the
third.

On a pull request from a fork, the token is read-only. The comment is not
posted; the projection stays in the job summary, and the run logs a warning
saying so. See [`examples/`](examples/) for a fork-safe pair that posts the
comment anyway.

## Plain mode

If your release workflow configures release-please with inputs instead of
those files, pass this action the same values:

```yaml
      - uses: jmcvetta/projected-releases-action@v0
        with:
          release-type: node
```

`versioning-strategy`, `release-as`, `package-path`, and
`include-component-in-tag` work the same way. The comment warns when these
disagree with your release workflow.

## Merge method

The projection follows your repository's merge settings, and assumes a
squash-merge wherever squash is allowed. To project a different merge:

```yaml
      - uses: jmcvetta/projected-releases-action@v0
        with:
          merge-method: merge   # or rebase
```

| merge method | what is projected |
| --- | --- |
| squash | the pull request title and description, as one commit |
| rebase | the branch's commits |
| merge | the branch's commits, plus the merge commit |

## Outputs

| Output | What it holds |
| --- | --- |
| `comment-file` | The file the comment body was written to. |
| `body` | The rendered comment body. |
| `releases` | The projected releases as JSON, one `{component, version, notes}` per tag merging would cut. |
| `releases-count` | How many releases merging would cut. `0` is the common case. |
| `malformed-title` | `true` when the projection was withheld because the title is not a Conventional Commit the changelog recognizes. |
| `recognized-types` | The commit types this run resolved, comma-separated. Pin a PR-title gate to this instead of keeping a second copy of the list. |

A later step reads them through `steps.<id>.outputs`:

```yaml
      - id: projected
        uses: jmcvetta/projected-releases-action@v0
      - if: steps.projected.outputs.malformed-title == 'true'
        run: exit 1
```

This action also writes the projection to the job summary; set
`step-summary: false` to turn that off.

## More

- [`examples/`](examples/) has a fuller workflow, and a fork-safe pair for
  repositories that take pull requests from forks.
- [`action.yml`](action.yml) documents every input and output.
- Running on GitHub Enterprise Server: `api-url` and `graphql-url` default to
  the running server's and can be set for a GHES instance.
