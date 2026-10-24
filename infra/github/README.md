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

Change `name` in `main.tf` and apply.

The plan replaces `github_repository_vulnerability_alerts` and
`github_repository_dependabot_security_updates`, which is expected: each holds
one boolean that the apply restores. It must **update `github_repository` in
place** — a plan proposing to replace that one deletes the repository, so stop
and read it.

GitHub redirects the old name until somebody creates a repository under it.

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
touched. The `infra` filter in `.github/workflows/ci.yml` selects its setup,
validation and lockfile steps for changes to this directory or `package.json`.
The `Checks` job always reports; the filter gates only its steps, so unrelated
pull requests still receive the required context without downloading the
toolchain or provider.

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
| `github_actions_variable.release_bot_app_id` | the non-secret App ID | no |
| `github_workflow_repository_permissions` | two Actions settings | no |

The last four rows describe settings the API will not hand an anonymous reader,
so committing the state publishes them: vulnerability alerts and Dependabot
updates are enabled, workflow permissions are set, and the App ID is recorded.

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

- **A separate infrastructure check.** The `Checks` context is required
  alongside `Release Projection`. Its `infra` path filter selects the
  OpenTofu steps inside `ci.yml`; it does not suppress the required job on
  other pull requests. The `Release Projection` job runs the title gate and
  projection, with only the projection skipped on release-please branches.

  Once installed and configured, the release App opens its pull request with a
  distinct identity, so GitHub runs both required checks without an approval
  click.

- **The release App.** `RELEASE_BOT_APP_ID` is managed here as the non-secret
  ID `4861873`. Install that App on this repository, then set its private key
  as the hand-managed `RELEASE_BOT_PRIVATE_KEY` secret, which never enters
  configuration or state. Do both before applying: setting the variable
  without the key makes the release job fail on its first step. If the
  variable already exists live, import it before planning with
  `tofu import github_actions_variable.release_bot_app_id
  projected-releases-action:RELEASE_BOT_APP_ID`. Then run `tofu plan`: an
  absent variable should show only one creation; an imported variable whose
  live value is `4861873` should show no changes. Review any proposed value
  update and apply only the expected change, with no unrelated changes; commit
  the resulting state.

- **Labels.** Untouched GitHub defaults that nothing in the workflow reads.
  Managing them would encode a default nobody chose.

- **`has_downloads`.** GitHub retired the legacy downloads feature and the
  provider deprecated the field, so setting it is inert.

- **`topics` and `homepage_url`.** Both empty on the repository today.
  Declaring them here would manage them to empty, which is a claim this file
  has no reason to make.
