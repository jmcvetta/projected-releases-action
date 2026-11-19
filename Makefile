#===============================================================================
#
# Makefile
#
#===============================================================================

SHELL := /bin/bash
.SHELLFLAGS := -o pipefail -c

.PHONY: __git_sync_run check-git-sync

# __git_sync_run: implementation for the `wt sync` alias, which switches to
# master's worktree before invoking this target. Pull the remote, prune
# references, then let Worktrunk remove every branch and worktree it finds
# integrated into master, including squash-merged ones. Dirty or locked
# worktrees remain untouched.
__git_sync_run:
	git pull
	git fetch --prune
	@remote=$$(git config --get branch.master.remote); \
	if [ -z "$$remote" ]; then \
		printf 'WARN: master has no remote; skipping branch cleanup\n' >&2; \
		exit 0; \
	fi; \
	if ! wt step prune --foreground --min-age 0; then \
		printf 'WARN: worktree cleanup failed\n' >&2; \
	fi

check-git-sync:
	python3 scripts/check-git-sync.py
