# Projected Releases for release-please

[![Test](https://github.com/jmcvetta/release-please-projected-releases-action/actions/workflows/test.yml/badge.svg)](https://github.com/jmcvetta/release-please-projected-releases-action/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/release/jmcvetta/release-please-projected-releases-action)](https://github.com/jmcvetta/release-please-projected-releases-action/releases)
[![License](https://img.shields.io/github/license/jmcvetta/release-please-projected-releases-action)](LICENSE)

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

That is all a repository with `release-please-config.json` and
`.release-please-manifest.json` needs. Keep `edited` in the trigger list, so
a title fixed after review re-renders the comment, and keep `fetch-depth: 0`,
which the merge and rebase projections need.

## Plain mode

If your release workflow configures release-please with inputs instead of
those files, pass this action the same values:

```yaml
      - uses: jmcvetta/release-please-projected-releases-action@v0
        with:
          release-type: node
```

`versioning-strategy` and `release-as` work the same way. The comment warns
when these disagree with your release workflow.

## Merge method

The projection follows your repository's merge settings, and assumes a
squash-merge wherever squash is allowed. To project a different merge:

```yaml
      - uses: jmcvetta/release-please-projected-releases-action@v0
        with:
          merge-method: merge   # or rebase
```

| merge method | what is projected |
| --- | --- |
| squash | the pull request title and description, as one commit |
| rebase | the branch's commits |
| merge | the branch's commits, plus the merge commit |

## More

- [`examples/`](examples/) has a fuller workflow, and a fork-safe pair for
  repositories that take pull requests from forks.
- [`action.yml`](action.yml) documents every input and output.
