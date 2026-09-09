# Projected Releases for release-please

[![Test](https://github.com/jmcvetta/release-please-projected-releases-action/actions/workflows/test.yml/badge.svg)](https://github.com/jmcvetta/release-please-projected-releases-action/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/release/jmcvetta/release-please-projected-releases-action)](https://github.com/jmcvetta/release-please-projected-releases-action/releases)
[![License](https://img.shields.io/github/license/jmcvetta/release-please-projected-releases-action)](LICENSE)

A GitHub Action that answers, on the pull request itself, what
[release-please](https://github.com/googleapis/release-please) will do when
the pull request merges: which packages release, at what version, and under
which tag. When the answer is nothing, the comment says so plainly.

It runs release-please itself, bundled into the action, over the commits
the merge will write. The projection is release-please's own arithmetic, not
a reimplementation of its rules.

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

One sticky comment, re-rendered as the title or the branch changes. When
nothing releases there is no table, just ``None — `docs:` produces no
release.`` When a version cannot be trusted, because the manifest names a
version no release or tag matches, the comment says so instead of presenting
it as the answer.

## Quick start

Copy to `.github/workflows/projected-releases.yml`:

```yaml
name: Projected releases
on:
  pull_request:
    types: [opened, reopened, synchronize, edited]
permissions:
  contents: read
  pull-requests: write
jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: jmcvetta/release-please-projected-releases-action@v0
```

`edited` is in the trigger list because a title fixed after review has to
re-render. `fetch-depth: 0` lets the action read the branch's commits from
the checkout instead of the API. `@v0` tracks the latest `0.x`.

[`examples/`](examples/) has a fuller version of this workflow, and a
fork-safe pair for repositories that take pull requests from forks, where the
token cannot comment.

## Merge method

Under a squash-merge the pull request title becomes the commit, so the title
is what release-please parses. Under a merge commit or a rebase, the branch's
own commits are. By default the projection follows the repository's settings,
and models a squash wherever squash is allowed. A repository that merges the
other way should say so:

```yaml
      - uses: jmcvetta/release-please-projected-releases-action@v0
        with:
          merge-method: merge   # or rebase, or squash
```

| the merge | what is projected |
| --- | --- |
| squash | the title and description, as one commit |
| rebase | the branch's commits |
| merge | the branch's commits, plus the merge commit GitHub writes |

## Configuration

None, where release-please reads `release-please-config.json` and
`.release-please-manifest.json` from the repository.

Without those files, release-please is configured by the inputs your release
workflow passes `release-please-action`. Pass this action the same values:

```yaml
      - uses: jmcvetta/release-please-projected-releases-action@v0
        with:
          release-type: node
```

`versioning-strategy` and `release-as` are passed the same way. The action
finds the release workflow and notes on the comment where the two disagree;
`release-workflow` points it at a specific file, or turns that check off.

Every input and output is documented in [`action.yml`](action.yml).
