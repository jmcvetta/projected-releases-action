#===============================================================================
#
# Makefile
#
#===============================================================================

SHELL := /bin/bash
.SHELLFLAGS := -o pipefail -c

.PHONY: git_sync

# git_sync: sync master with origin and delete local branches whose upstream
# is gone. A gone branch still checked out in a linked worktree has the
# worktree removed first; `git worktree remove` refuses a worktree holding
# uncommitted or untracked files (or one that is locked), and any refused
# worktree is warned about and kept, branch included.
git_sync:
	git checkout master
	git pull
	git fetch --prune
	git branch -vv | awk '/: gone\]/ {sub(/^\+ /, ""); print $$1}' | \
	while read -r b; do \
		wt=$$(git worktree list --porcelain | awk -v b="$$b" '/^worktree /{p = substr($$0, 10)} /^branch /{if (substr($$0, 8) == "refs/heads/" b) {print p; exit}}'); \
		if [ -n "$$wt" ]; then \
			if ! git worktree remove "$$wt"; then \
				printf 'WARN: worktree for gone-upstream branch %s could not be removed; kept: %s\n' "$$b" "$$wt" >&2; \
				continue; \
			fi; \
			printf 'removed stale worktree: %s\n' "$$wt"; \
		fi; \
		git branch -D "$$b"; \
	done
