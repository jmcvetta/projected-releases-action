#===============================================================================
#
# Makefile
#
#===============================================================================

SHELL := /bin/bash
.SHELLFLAGS := -o pipefail -c

.PHONY: __git_sync_run check-git-sync

# __git_sync_run: implementation for `wt sync`, which first switches the caller
# to master's worktree. Offer gone-upstream branches to Worktrunk for cleanup.
# Worktrunk decides whether each branch is integrated; it refuses dirty or
# locked worktrees and keeps branches that still add changes.
__git_sync_run:
	git pull
	git fetch --prune
	@git branch -vv | awk '/: gone\]/ {sub(/^\+ /, ""); print $$1}' | \
	while read -r b; do \
		wt=$$(git worktree list --porcelain | awk -v b="$$b" '/^worktree /{p = substr($$0, 10)} /^branch /{if (substr($$0, 8) == "refs/heads/" b) {print p; exit}}'); \
		if [ -n "$$wt" ]; then \
			if ! wt remove --foreground "$$wt"; then \
				printf 'WARN: worktree for gone-upstream branch %s could not be removed; kept: %s\n' "$$b" "$$wt" >&2; \
				continue; \
			fi; \
			printf 'removed stale worktree: %s\n' "$$wt"; \
		else \
			wt remove --foreground "$$b"; \
		fi; \
	done

check-git-sync:
	python3 scripts/check-git-sync.py
