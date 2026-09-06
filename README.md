# projected-releases

[![Test](https://github.com/jmcvetta/release-please-projected-releases-action/actions/workflows/test.yml/badge.svg)](https://github.com/jmcvetta/release-please-projected-releases-action/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/release/jmcvetta/release-please-projected-releases-action)](https://github.com/jmcvetta/release-please-projected-releases-action/releases)
[![License](https://img.shields.io/github/license/jmcvetta/release-please-projected-releases-action)](LICENSE)

A GitHub Action that comments on a pull request with the release-please tags
merging it will cut — or says plainly that nothing is released. The numbers
come from a bundled release-please, not a reimplementation of its rules.

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
release.``

It also says when the numbers cannot be trusted. If a component's entry in
`.release-please-manifest.json` names a version that no release or tag
matches, release-please has no boundary to compute from: it replays the
component's whole history into one changelog and reaches a version by
arithmetic over all of it. That is what a lost tag looks like — and what a
first release looks like — so the comment reports the disagreement and marks
the affected version as unreliable rather than presenting it as the answer.

## Does it fit your repository?

- **release-please**, manifest mode or plain mode (`release-type:`).
- **Any merge method.** Squash-merge is the default and the one that makes
  the pull request title the commit. Merge commits and rebase are projected
  from the branch's own commits instead — see below.

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

Keep `edited` in the trigger list: under squash-merge the projection comes
from the title, so a title fixed after review has to re-render. Keep
`fetch-depth: 0` too: the checkout answers what each commit changed, which the
API otherwise answers one request per commit. `@v0` tracks the latest `0.x`,
and [`examples/projected-releases.yml`](examples/projected-releases.yml) adds
a `concurrency` group and skips release-please's own release pull requests.

## Merge commits and rebase

A squash-merge writes one commit and its subject is the pull request title, so
the title is what release-please parses. A merge commit or a rebase puts the
branch's own commits on the target branch individually, and release-please
parses those. The projection follows the repository:

| the merge | what is projected |
| --- | --- |
| squash | the title and description, as one commit |
| rebase | the branch's commits, each with its own files |
| merge | the same, plus the merge commit GitHub writes above them |

By default the repository's settings decide, and they resolve to squash
wherever squash is allowed — which is nearly everywhere, and is the button
most people press. A repository that really merges the other way should say
so:

```yaml
      - uses: jmcvetta/release-please-projected-releases-action@v0
        with:
          merge-method: merge   # or rebase, or squash
```

Two things change when the branch's commits are the input. The title's type
no longer decides anything, so a title that is not a Conventional Commit is
not a problem and the `malformed-title` output is always `false`. And the
merge commit is not a formality: GitHub's default `merge_commit_message` is
`PR_TITLE`, which puts the title in the merge commit's body, where
release-please parses it as a commit of its own — so a merge-commit repository
releases from the title *and* from the branch. The action reads
`merge_commit_title` and `merge_commit_message` from the repository so the
projection matches whichever way they are set.

This needs the branch's commits, with the files each one changes.
`fetch-depth: 0` supplies them from the checkout in one `git log`. Without it
the action falls back to the API, which has no per-commit files endpoint and
so costs one request per commit; past fifty it declines, and the comment says
the merge could not be modelled rather than showing the squash answer as
though it were one.

## Configuration

None, where release-please reads `release-please-config.json` and
`.release-please-manifest.json` from the repository.

Without those files, release-please is configured by the `release-type:` your
release workflow passes it. Pass this action the same value:

```yaml
      - uses: jmcvetta/release-please-projected-releases-action@v0
        with:
          release-type: node
```

Setting it is what selects that mode — here as on `release-please-action`,
where its presence is likewise the switch — so the two have to agree. Set it
where your release workflow does not and the projection describes a
configuration that will never run; the comment says so when it can tell, which
is when the config files are in the checkout.

`versioning-strategy` and `release-as` are passed the same way, and matter for
the same reason: a workflow bumping with `always-bump-patch` releases a feature
as a patch, and `release-as` is sticky — it holds until the line is removed. A
projection that has not been told about either reports the version a default
repository would get.

`component` and `tag-separator` go the other way: `release-please-action` has
no input for them at all, so leave them alone unless something other than it
cuts your releases.
