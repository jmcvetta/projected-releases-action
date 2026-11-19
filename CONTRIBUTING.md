# Contributing

Issues and pull requests are welcome.

```
npm ci
npm run check     # typecheck, build, test
npm run cover     # the same, with coverage
```

`dist/index.mjs` is committed — `npm run check` rebuilds it, so commit it with
your change or CI will fail on a stale bundle.

## Worktree sync

Install [Worktrunk](https://worktrunk.dev/#install), then configure its shell
integration:

```sh
wt config shell install
```

From a linked worktree, run `wt sync`. It switches the calling shell to the
master worktree, pulls and prunes remote references, then lets Worktrunk
remove the branches and worktrees it finds integrated into master, including
squash-merged ones. Worktrunk keeps the main worktree and every worktree that
is dirty, locked, or whose branch still contains unpublished changes.
