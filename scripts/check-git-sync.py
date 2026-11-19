#!/usr/bin/env python3
"""Exercise Worktrunk sync against disposable Git repositories, never this checkout."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


def run(
    cwd: Path, *args: str, env: dict[str, str] | None = None, check: bool = True
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True, check=check)


def branch_exists(repo: Path, branch: str) -> bool:
    return (
        run(repo, "git", "show-ref", "--verify", f"refs/heads/{branch}", check=False).returncode
        == 0
    )


class SyncTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="wt-sync-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.primary = self.root / "primary"
        self.remote = self.root / "remote.git"
        self.caller = self.root / "caller worktree"
        self.stale = self.root / "stale worktree"
        self.env = os.environ.copy()
        config = self.root / "user.toml"
        config.write_text("skip-shell-integration-prompt = true\n", encoding="utf-8")
        system = self.root / "system.toml"
        system.touch()
        self.env.update(WORKTRUNK_CONFIG_PATH=str(config), WORKTRUNK_SYSTEM_CONFIG_PATH=str(system))
        self.env.pop("WORKTRUNK_PROJECT_CONFIG_PATH", None)
        self.env.pop("WORKTRUNK_WORKTREE_PATH", None)

        run(self.root, "git", "init", "--bare", "--initial-branch=master", str(self.remote))
        run(self.root, "git", "init", "--initial-branch=master", str(self.primary))
        (self.primary / ".config").mkdir()
        shutil.copy2(ROOT / ".config/wt.toml", self.primary / ".config/wt.toml")
        shutil.copy2(ROOT / "Makefile", self.primary / "Makefile")
        (self.primary / "tracked.txt").write_text("master\n", encoding="utf-8")
        run(self.primary, "git", "config", "user.name", "Sync Test")
        run(self.primary, "git", "config", "user.email", "sync@example.invalid")
        run(self.primary, "git", "add", "Makefile", ".config/wt.toml", "tracked.txt")
        run(self.primary, "git", "commit", "-m", "seed")
        run(self.primary, "git", "remote", "add", "origin", str(self.remote))
        run(self.primary, "git", "push", "-u", "origin", "master")
        run(self.primary, "git", "worktree", "add", "-b", "stale", str(self.stale), "master")
        (self.stale / "tracked.txt").write_text("integrated\n", encoding="utf-8")
        run(self.stale, "git", "add", "tracked.txt")
        run(self.stale, "git", "commit", "-m", "integrated change")
        run(self.stale, "git", "push", "-u", "origin", "stale")
        run(self.primary, "git", "worktree", "add", "-b", "caller", str(self.caller), "master")

    def merge_stale(self) -> None:
        """Integrate the stale branch into master by fast-forward, leaving its upstream live."""
        run(self.primary, "git", "merge", "--ff-only", "stale")
        run(self.primary, "git", "push", "origin", "master")

    def squash_stale(self) -> None:
        """Integrate the stale branch into master by squash, leaving its upstream live."""
        run(self.primary, "git", "merge", "--squash", "stale")
        run(self.primary, "git", "commit", "-m", "integrate stale by squash")
        run(self.primary, "git", "push", "origin", "master")

    def sync(self) -> subprocess.CompletedProcess[str]:
        command = 'set -e; eval "$(command wt config shell init bash)"; wt -y sync; pwd'
        return run(self.caller, "bash", "--noprofile", "--norc", "-c", command, env=self.env)

    def test_fast_forward_merged_worktree_is_removed(self) -> None:
        """A branch whose commits master contains is removed with its worktree."""
        self.merge_stale()
        self.sync()
        self.assertFalse(self.stale.exists())
        self.assertFalse(branch_exists(self.primary, "stale"))

    def test_squash_merged_branch_with_live_upstream_is_removed(self) -> None:
        """A squash merge leaves no shared commit, so ancestry alone proves nothing."""
        self.squash_stale()
        result = self.sync()
        self.assertEqual(result.returncode, 0)
        self.assertFalse(self.stale.exists())
        self.assertFalse(branch_exists(self.primary, "stale"))
        self.assertTrue(
            run(
                self.primary,
                "git",
                "show-ref",
                "--verify",
                "refs/remotes/origin/stale",
                check=False,
            ).returncode
            == 0
        )
        self.assertTrue(
            run(
                self.remote,
                "git",
                "show-ref",
                "--verify",
                "refs/heads/stale",
                check=False,
            ).returncode
            == 0
        )

    def test_linked_caller_returns_to_master_and_removes_merged_worktrees(self) -> None:
        """Shell integration leaves the caller in master before merged worktrees are removed."""
        self.merge_stale()
        result = self.sync()
        self.assertEqual(result.stdout.splitlines()[-1], str(self.primary))
        self.assertFalse(self.stale.exists())
        self.assertFalse(branch_exists(self.primary, "stale"))
        self.assertFalse(self.caller.exists())
        self.assertFalse(branch_exists(self.primary, "caller"))

    def test_merged_direct_branch_with_upstream_is_removed(self) -> None:
        """An existing remote must not keep a merged local branch alive."""
        run(self.primary, "git", "branch", "direct", "master")
        run(self.primary, "git", "push", "-u", "origin", "direct")
        self.sync()
        self.assertFalse(branch_exists(self.primary, "direct"))

    def test_merged_linked_branch_with_upstream_is_removed(self) -> None:
        """Merged cleanup must include linked worktrees whose upstreams still exist."""
        self.merge_stale()
        self.sync()
        self.assertFalse(self.stale.exists())
        self.assertFalse(branch_exists(self.primary, "stale"))

    def test_merged_branch_without_upstream_metadata_is_removed(self) -> None:
        """A fully integrated branch needs no tracking metadata to be removed."""
        run(self.primary, "git", "branch", "--unset-upstream", "stale")
        self.merge_stale()
        self.sync()
        self.assertFalse(self.stale.exists())
        self.assertFalse(branch_exists(self.primary, "stale"))

    def test_unmerged_branch_with_upstream_is_kept(self) -> None:
        """Cleanup must not remove a worktree that still adds commits."""
        (self.stale / "new.txt").write_text("unpublished\n", encoding="utf-8")
        run(self.stale, "git", "add", "new.txt")
        run(self.stale, "git", "commit", "-m", "unpublished change")
        run(self.stale, "git", "push", "-u", "origin", "stale")
        self.sync()
        self.assertTrue(self.stale.exists())
        self.assertTrue(branch_exists(self.primary, "stale"))

    def test_unmerged_branch_without_upstream_metadata_is_kept(self) -> None:
        """A branch missing tracking metadata still guards unpublished commits."""
        (self.stale / "new.txt").write_text("unpublished\n", encoding="utf-8")
        run(self.stale, "git", "add", "new.txt")
        run(self.stale, "git", "commit", "-m", "unpublished change")
        run(self.primary, "git", "branch", "--unset-upstream", "stale")
        self.sync()
        self.assertTrue(self.stale.exists())
        self.assertTrue(branch_exists(self.primary, "stale"))

    def test_dirty_stale_worktree_is_kept(self) -> None:
        """Worktrunk skips a dirty worktree silently; user files and the branch survive."""
        self.merge_stale()
        (self.stale / "user-data.txt").write_text("keep\n", encoding="utf-8")
        result = self.sync()
        self.assertEqual(result.stdout.splitlines()[-1], str(self.primary))
        self.assertNotIn("could not be removed", result.stderr)
        self.assertTrue(self.stale.exists())
        self.assertEqual((self.stale / "user-data.txt").read_text(encoding="utf-8"), "keep\n")
        self.assertTrue(branch_exists(self.primary, "stale"))

    def test_locked_worktree_is_kept(self) -> None:
        """An integrated branch must not take a locked worktree."""
        self.merge_stale()
        run(self.primary, "git", "worktree", "lock", str(self.stale))
        self.sync()
        self.assertTrue(self.stale.exists())
        self.assertTrue(branch_exists(self.primary, "stale"))

    def test_advanced_worktree_is_kept(self) -> None:
        """An integrated branch that gained commits is no longer integrated."""
        self.merge_stale()
        (self.stale / "later.txt").write_text("later work\n", encoding="utf-8")
        run(self.stale, "git", "add", "later.txt")
        run(self.stale, "git", "commit", "-m", "later work")
        self.sync()
        self.assertTrue(self.stale.exists())
        self.assertTrue(branch_exists(self.primary, "stale"))


if __name__ == "__main__":
    unittest.main()
