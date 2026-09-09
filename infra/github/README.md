# GitHub repository configuration

The settings on this GitHub repository — merge strategy, the `master` ruleset,
whether Actions may open a pull request — expressed as OpenTofu so they are
reviewable in a diff instead of clicked through a settings UI and forgotten.

The point is not the ten minutes it saves. It is that a change to branch
protection arrives as a pull request someone can read, and that a setting the
release job silently depends on is written down next to the reason it is
needed.

## Running it

The provider authenticates from `GITHUB_TOKEN`; no credentials live in this
repository. The token needs `repo` scope and admin on the repository.

```sh
cd infra/github
export GITHUB_TOKEN=$(gh auth token)
tofu init
tofu plan
```

Install the version in `.opentofu-version`, which is also what CI reads. A
version manager (`tenv`, `asdf`, `mise`) picks the file up from this directory
on its own; otherwise match it by hand.

A clean checkout plans as **`No changes.`** Anything else means either someone
changed a setting in the web UI, or a change here has not been applied yet —
the plan output tells you which.

### Renaming the repository

Change `name` in `main.tf` and apply. **The rename is the apply's to make** —
the provider renames the repository in place rather than replacing it, so
doing it in the web UI first is not required.

Measured with `tofu plan` on the 0.7.1 tree, renaming to
`projected-releases-action`:

| Resource | Action |
|---|---|
| `github_repository` | updated in place — this is the rename |
| `github_repository_ruleset` | updated in place |
| `github_workflow_repository_permissions` | updated in place |
| `github_repository_vulnerability_alerts` | **replaced** |
| `github_repository_dependabot_security_updates` | **replaced** |

The two replacements look alarming and are not. Each holds one boolean, and
destroying and re-creating it sets that boolean back to what the configuration
says; nothing accumulates in them to lose.

**What decides a replacement is `ForceNew` on the `repository` attribute, not
how the resource is keyed** — a distinction worth having, because the ids in
state suggest the opposite rule and it does not hold.
`github_repository_vulnerability_alerts` is keyed on the numeric repository id
and is replaced; `github_workflow_repository_permissions` is keyed on the name
and is not.

`github_repository` is the one where a replacement would matter, because
destroying it deletes the repository. Its `name` is not `ForceNew`, which is
what makes the rename an in-place update; a plan that ever says otherwise is a
plan to stop and read rather than apply.

The replacement is a destroy and then a create, and the destroy runs against
the old name after the repository has been renamed. It resolves through
GitHub's redirect, so it works — but vulnerability alerts are briefly off
rather than merely re-asserted.

Read the plan before applying regardless. That is the standing rule below and
it is not weakened by having measured this once: the answer above is a
property of a provider version, not a law.

GitHub redirects the old name for clones, links and `uses:` lines, so callers
keep working — but only until somebody creates a repository under the old
name, which is a thing anyone may do.

### The provider lock has to be what init produces

`.terraform.lock.hcl` is committed, and CI fails if `tofu init` would change
it. That is stricter than it sounds: initialising against the registry records
an `h1:` hash for every platform the provider publishes, so a lock file
carrying fewer of them is rewritten on the next init, on any machine. A file
that init rewrites is not a pin anyone reads — the diff appears, nobody asked
for it, and it gets committed unread.

So when the provider version changes, let init write the file and commit what
it wrote:

```sh
cd infra/github
tofu init -backend=false
git diff -- .terraform.lock.hcl
```

## Checking a change before applying it

`tofu apply` is the first thing that parses these files, and it runs against
live branch protection — a bad moment to discover a typo. `npm run check:infra`,
from the repository root, moves that discovery earlier:

```sh
npm run check:infra
```

It runs `tofu fmt -check`, then `tofu init -backend=false`, then
`tofu validate`. The `-backend=false` is what keeps it credential-free:
providers are installed for validation, and neither state nor the GitHub API is
touched. `.github/workflows/infra.yml` runs it on every pull request that
touches this directory, so a syntax error or an attribute the provider does not
have fails in review. It is its own workflow so that GitHub's `paths:` filter
can gate it: a pull request that changes only `src/` should not be paying for a
toolchain download and a provider fetch.

It is not part of `npm run check`, which is the typecheck-build-test chain a
laptop runs constantly and which must not start requiring OpenTofu to be
installed.

This is not a substitute for reading `tofu plan` before an apply. Validation
knows the configuration is well-formed; only the plan knows what it will do.

## Where state lives, and why it is committed

`terraform.tfstate` is committed to this repository. That is deliberate, and it
is the part most likely to look like a mistake to someone skimming — more so
here than in a private repository, because this one is public and its state is
therefore world-readable.

The reflex against committed state comes from state files that hold database
passwords and generated keys. **This stack holds none, by construction.** What
it does hold, in full:

| Resource | What is in state | Readable without admin? |
|---|---|---|
| `github_repository` | name, ids, clone URLs, feature flags | yes, it is public metadata |
| `github_repository_ruleset` | the branch-protection rules | yes |
| `github_repository_vulnerability_alerts` | a boolean | no |
| `github_repository_dependabot_security_updates` | a boolean | no |
| `github_workflow_repository_permissions` | two Actions settings | no |

The last three are settings the API will not hand an anonymous reader, so
committing the state publishes them. That is a disclosure and not an accident:
they say that Dependabot is on and that a workflow token is read-only unless a
job asks for more. Neither is a thing anyone can use.

Against that, the alternatives cost more than they return. An S3 backend means
an AWS account this repository has no other reason to touch; a hosted backend
means a paid external dependency in a project that has none. Keeping no state
at all would mean re-importing before every change and accepting silent drift,
which defeats the purpose. Merge conflicts on state are the real cost of
committing it, and with one operator applying occasionally they are rare and
resolvable by re-importing.

### The rule that keeps this safe

**Only add resources whose values are safe to publish.**

This is a constraint on future edits, not a one-time observation. Committed
state is a durable artifact: git history is append-only in practice, so a
credential committed once is not fixed by deleting it in a later commit — it
stays in the history of every clone and of every fork. This repository being
public means there is no blast radius to limit.

The test is not whether a field is labelled secret. It is whether the value
does anything for someone who has it: a token, a key, a webhook URL that
accepts requests. Adding a resource that carries one — `github_actions_secret`,
a webhook, a deploy key — means **moving state off-repo first**, not making an
exception for the one resource.

## What is not managed here, and why

- **`test` as a required check.** `validate-title` is required (see below);
  `test` is not, and the reason is `test.yml`'s `paths:` filter. A
  path-filtered workflow reports no check run at all rather than a skipped
  one, so a required `test` would leave every pull request that matches
  nothing in its allow-list pending for ever, fixable only by someone
  hand-applying this stack. Requiring it means dropping the filter in the
  same commit, and nothing enforces that.

  What the release pull request costs is a separate thing, and it is a click
  rather than an absence. The release job falls back to the default token, so
  that pull request is opened by `github-actions[bot]`, and GitHub holds a
  bot's workflow runs in `action_required` until someone with write access
  clicks **Approve workflows to run**. `validate-title` therefore reports
  there one click late — #79 has four check runs, each a second attempt a
  human triggered, and it merged on a green `validate-title` without the
  bypass. The release bot App below removes the click.

  `preview` stays out of it whatever happens. That job is advisory by design
  and skips itself on release-please's own branches, so as a required check it
  would never report there either.

- **`RELEASE_BOT_APP_ID` and `RELEASE_BOT_PRIVATE_KEY`.** `release-please.yml`
  switches to a GitHub App when the variable is set, and the point of doing so
  is that an App is a distinct identity, so GitHub does not hold the workflow
  runs on its pull requests for approval — measured on
  `jmcvetta/claude-daily-driver`, whose release pull requests run at the first
  attempt with the App as the triggering actor. It removes an approval click,
  not an event suppression. The private
  key cannot be managed here under the rule above, and the variable is
  deliberately not managed either: setting it while the key is missing or the
  App is not installed makes the release job fail on its first step, which is
  worse than the fallback it replaces. Both go in together, by hand, alongside
  installing the App on this repository.

- **Labels.** Untouched GitHub defaults that nothing in the workflow reads.
  Managing them would encode a default nobody chose.

- **`has_downloads`.** GitHub retired the legacy downloads feature and the
  provider deprecated the field, so setting it is inert.

- **`topics` and `homepage_url`.** Both empty on the repository today.
  Declaring them here would manage them to empty, which is a claim this file
  has no reason to make.
