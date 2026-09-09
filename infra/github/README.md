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
  `test` is not, and the difference is only which cost is worth paying. The
  release job falls back to the default token, so the release pull request is
  opened by `github-actions[bot]`, and GitHub holds every workflow run on a
  bot's pull request until someone with write access clicks **Approve
  workflows to run**. Until 2026-06-11 it created no runs at all — #42 has
  zero check runs — and required `validate-title` sat "expected" there until
  an admin bypassed it. Since then the checks do report, one click late: #79
  has four of them, and merged without the bypass. Requiring `test` as well
  would add nothing to that click, and nothing prevents it any more. It goes
  in when someone decides it should; the release bot App below removes the
  click itself.

  `preview` stays out of it whatever happens. That job is advisory by design
  and skips itself on release-please's own branches, so as a required check it
  would never report there either.

- **`RELEASE_BOT_APP_ID` and `RELEASE_BOT_PRIVATE_KEY`.** `release-please.yml`
  switches to a GitHub App when the variable is set, and the point of doing so
  is that an App is a distinct identity whose pushes do produce workflow
  events, so the release pull request arrives with checks on it. The private
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
