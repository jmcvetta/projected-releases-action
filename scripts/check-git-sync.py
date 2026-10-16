#!/usr/bin/env python3
"""Exercise Worktrunk sync against disposable Git repositories, never this checkout."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


def run(cwd: Path, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True, check=True)


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
        run(self.primary, "git", "merge", "--ff-only", "stale")
        run(self.primary, "git", "push", "origin", "master")
        run(self.primary, "git", "push", "origin", "--delete", "stale")
        run(self.primary, "git", "worktree", "add", "-b", "caller", str(self.caller), "master")

    def sync(self) -> subprocess.CompletedProcess[str]:
        command = 'set -e; eval "$(command wt config shell init bash)"; wt -y sync; pwd'
        return run(self.caller, "bash", "--noprofile", "--norc", "-c", command, env=self.env)

    def test_linked_caller_returns_to_master_and_removes_stale_branch(self) -> None:
        """A child-process checkout can clean a branch but cannot change the calling shell."""
        result = self.sync()
        self.assertEqual(result.stdout.splitlines()[-1], str(self.primary))
        self.assertIn(f"removed stale worktree: {self.stale}", result.stdout)
        self.assertFalse(self.stale.exists())
        self.assertNotIn("stale", run(self.primary, "git", "branch", "--list", "stale").stdout)
        self.assertTrue(self.caller.exists())

    def test_unintegrated_branch_keeps_changes_after_worktree_removal(self) -> None:
        """A gone upstream alone must not force-delete unpublished commits."""
        (self.stale / "new.txt").write_text("unpublished\n", encoding="utf-8")
        run(self.stale, "git", "add", "new.txt")
        run(self.stale, "git", "commit", "-m", "unpublished change")
        result = self.sync()
        self.assertEqual(result.stdout.splitlines()[-1], str(self.primary))
        self.assertFalse(self.stale.exists())
        self.assertIn("stale", run(self.primary, "git", "branch", "--list", "stale").stdout)

    def test_gone_direct_branch_is_removed_by_worktrunk(self) -> None:
        """Branch-only cleanup must use the same integration guard as linked cleanup."""
        run(self.primary, "git", "branch", "direct", "master")
        run(self.primary, "git", "push", "-u", "origin", "direct")
        run(self.primary, "git", "push", "origin", "--delete", "direct")
        self.sync()
        self.assertNotIn("direct", run(self.primary, "git", "branch", "--list", "direct").stdout)

    def test_dirty_stale_worktree_is_kept(self) -> None:
        """Cleanup must not delete user files or the branch that owns them."""
        (self.stale / "user-data.txt").write_text("keep\n", encoding="utf-8")
        result = self.sync()
        self.assertEqual(result.stdout.splitlines()[-1], str(self.primary))
        self.assertIn("could not be removed; kept", result.stderr)
        self.assertEqual((self.stale / "user-data.txt").read_text(encoding="utf-8"), "keep\n")
        self.assertIn("stale", run(self.primary, "git", "branch", "--list", "stale").stdout)


if __name__ == "__main__":
    unittest.main()
