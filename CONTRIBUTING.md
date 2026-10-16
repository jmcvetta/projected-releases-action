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
master worktree, pulls and prunes remote references, then offers gone-upstream
branches to Worktrunk for safe cleanup. Worktrunk keeps worktrees that are
dirty, locked, or whose branches still contain unpublished changes.
