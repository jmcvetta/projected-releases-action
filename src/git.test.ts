import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { branchCommits, changedFiles, commitFileIndex, hasCommit } from "./git.js";

describe("changedFiles", () => {
  it("diffs from the merge base, not the base tip", () => {
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      return args[0] === "merge-base" ? "deadbeef\n" : "a.ts\nb/c.ts\n";
    };
    expect(changedFiles("origin/master", "HEAD", run)).toEqual([
      "a.ts",
      "b/c.ts",
    ]);
    expect(calls[0]).toEqual(["merge-base", "origin/master", "HEAD"]);
    expect(calls[1]).toEqual(["diff", "--name-only", "deadbeef", "HEAD"]);
  });

  it("drops blank lines", () => {
    const run = (args: string[]) =>
      args[0] === "merge-base" ? "sha\n" : "a.ts\n\n\n";
    expect(changedFiles("m", "h", run)).toEqual(["a.ts"]);
  });
});

describe("changedFiles, against the checkout it is running in", () => {
  // The injected runner above proves the arguments; this proves the default
  // one, which is the only part of this module a workflow actually uses and
  // the part that is one typo from failing on every pull request.
  it("diffs a ref against itself and finds nothing", () => {
    // True in any checkout, shallow ones included: the merge base of HEAD
    // and HEAD is HEAD.
    expect(changedFiles("HEAD", "HEAD")).toEqual([]);
  });

  it("raises when the checkout cannot answer, so the caller can fall back", () => {
    // The signal src/action.ts turns into "check the repository out with
    // fetch-depth: 0" before reading the file list from the API instead.
    expect(() => changedFiles("origin/no-such-branch-here", "HEAD")).toThrow();
  });
});

describe("commitFileIndex", () => {
  const LOG = "\0aaa\n\nsrc/x.ts\nREADME.md\n\0bbb\n\nsrc/y.ts";

  it("reads a file list per commit", () => {
    const run = (args: string[]) =>
      args[0] === "rev-parse" ? "false\n" : LOG;
    expect(commitFileIndex(["origin/master"], 500, run)).toEqual(
      new Map([
        ["aaa", ["src/x.ts", "README.md"]],
        ["bbb", ["src/y.ts"]],
      ]),
    );
  });

  it("asks git for merge diffs, which it does not show by default", () => {
    // Without this a merge commit indexes as changing nothing, and a commit
    // attributed to no component is worse than one the API is asked about.
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      return args[0] === "rev-parse" ? "false\n" : LOG;
    };
    commitFileIndex(["origin/master"], 250, run);
    expect(calls[1]).toContain("--diff-merges=first-parent");
    expect(calls[1]).toContain("--max-count=250");
    expect(calls[1]?.at(-1)).toBe("origin/master");
  });

  it("declines a shallow checkout, which holds a fraction of the history", () => {
    const run = (args: string[]) => (args[0] === "rev-parse" ? "true\n" : LOG);
    expect(commitFileIndex(["origin/master"], 500, run)).toBeUndefined();
  });

  it("declines an index git had to quote a path in", () => {
    const run = (args: string[]) =>
      args[0] === "rev-parse" ? "false\n" : '\0aaa\n\n"src/a\\tb.ts"';
    expect(commitFileIndex(["origin/master"], 500, run)).toBeUndefined();
  });

  it("tries the next ref when one cannot be read", () => {
    const asked: string[] = [];
    const run = (args: string[]) => {
      if (args[0] === "rev-parse") return "false\n";
      const ref = args[args.length - 1] ?? "";
      asked.push(ref);
      if (ref !== "HEAD") throw new Error("unknown revision");
      return LOG;
    };
    expect(commitFileIndex(["origin/master", "master", "HEAD"], 500, run)?.size).toBe(2);
    expect(asked).toEqual(["origin/master", "master", "HEAD"]);
  });

  it("gives up rather than guessing when git is not there at all", () => {
    const run = () => {
      throw new Error("git: not found");
    };
    expect(commitFileIndex(["HEAD"], 500, run)).toBeUndefined();
  });
});

describe("commitFileIndex, against a real repository", () => {
  // The injected runners above prove the parsing; this proves it against what
  // git actually prints, which is the half that a reworded flag or a changed
  // default would break silently.
  it("indexes ordinary commits and merges alike", () => {
    const dir = mkdtempSync(join(tmpdir(), "commit-index-"));
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    const commit = (name: string, message: string) => {
      writeFileSync(join(dir, name), `${name}\n`);
      git(["add", name]);
      git(["commit", "-q", "-m", message]);
      return git(["rev-parse", "HEAD"]).trim();
    };

    try {
      git(["init", "-q", "-b", "master"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "Test"]);
      const first = commit("a.txt", "feat: a");
      git(["checkout", "-q", "-b", "topic"]);
      const branched = commit("b.txt", "feat: b");
      git(["checkout", "-q", "master"]);
      commit("c.txt", "feat: c");
      git(["merge", "-q", "--no-ff", "-m", "merge topic", "topic"]);
      const merge = git(["rev-parse", "HEAD"]).trim();

      const index = commitFileIndex(["master"], 500, git);
      expect(index?.get(first)).toEqual(["a.txt"]);
      expect(index?.get(branched)).toEqual(["b.txt"]);
      expect(index?.get(merge)).toEqual(["b.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("branchCommits", () => {
  // A NUL after each entry, which is what `git log -z` prints and what makes
  // a multi-line message safe to split on.
  const LOG = "aaa\nfix: two\n\0bbb\nfeat: one\n\nwith a body\n\0";
  const INDEX = "\0aaa\n\nui/y.ts\n\0bbb\n\napi/x.ts";
  const run = (args: string[]) => {
    if (args[0] === "rev-parse") return "false\n";
    return args.includes("--name-only") ? INDEX : LOG;
  };

  it("reads each commit's own message and own files", () => {
    // Its own files, not the pull request's: that is the difference between
    // a merge and a squash, and it is what attributes a bump to one package.
    expect(branchCommits("origin/master", "HEAD", 500, run)).toEqual([
      { sha: "aaa", message: "fix: two", files: ["ui/y.ts"] },
      { sha: "bbb", message: "feat: one\n\nwith a body", files: ["api/x.ts"] },
    ]);
  });

  it("reads the commits the base does not already have", () => {
    const calls: string[][] = [];
    const seen = (args: string[]) => {
      calls.push(args);
      return run(args);
    };
    branchCommits("origin/master", "topic", 250, seen);
    expect(calls[1]?.at(-1)).toBe("origin/master..topic");
    expect(calls[2]).toContain("-z");
    // One past the cap, which is what lets a branch at the cap be told from
    // one over it. See the truncation test below.
    expect(calls[2]).toContain("--max-count=251");
    expect(calls[2]?.at(-1)).toBe("origin/master..topic");
  });

  it("declines a branch longer than the depth rather than truncating it", () => {
    // The quiet answer this exists to refuse: `--max-count` alone returns the
    // newest commits and looks like the whole branch, so the oldest ones are
    // dropped with nothing anywhere saying so. The API path declines a long
    // branch out loud; the cheap path must not be the quiet one.
    expect(branchCommits("origin/master", "HEAD", 1, run)).toBeUndefined();
    expect(branchCommits("origin/master", "HEAD", 2, run)).toHaveLength(2);
  });

  it("declines a shallow checkout", () => {
    const shallow = (args: string[]) =>
      args[0] === "rev-parse" ? "true\n" : LOG;
    expect(branchCommits("origin/master", "HEAD", 500, shallow)).toBeUndefined();
  });

  it("declines when git is not there at all", () => {
    const missing = () => {
      throw new Error("git: not found");
    };
    expect(branchCommits("origin/master", "HEAD", 500, missing)).toBeUndefined();
  });

  it("declines when the message pass fails after the file pass did not", () => {
    const half = (args: string[]) => {
      if (args[0] === "rev-parse") return "false\n";
      if (args.includes("--name-only")) return INDEX;
      throw new Error("bad revision");
    };
    expect(branchCommits("origin/master", "HEAD", 500, half)).toBeUndefined();
  });

  it("declines rather than serving a commit with no file list", () => {
    // An empty list served confidently attributes the commit to no component,
    // which releases nothing and says nothing about why.
    const partial = (args: string[]) => {
      if (args[0] === "rev-parse") return "false\n";
      return args.includes("--name-only") ? "\0bbb\n\napi/x.ts" : LOG;
    };
    expect(branchCommits("origin/master", "HEAD", 500, partial)).toBeUndefined();
  });
});

describe("branchCommits, on the ref a pull_request event checks out", () => {
  // `actions/checkout` leaves HEAD at `refs/pull/N/merge` on a pull_request
  // event: GitHub's ephemeral merge of the branch into the base. Its diff is
  // the pull request's, which is why the file list is read from it -- but as
  // a *commit* it is one no merge and no rebase ever writes, and it carries
  // the whole branch's files. Reading commits from HEAD there puts it at the
  // front of the projection. The head sha is the branch tip itself and is a
  // parent of it, which is what src/action.ts prefers.
  it("reads the branch from the head sha, not from the merge ref", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-ref-"));
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    const commit = (name: string, message: string) => {
      writeFileSync(join(dir, name), `${name}\n`);
      git(["add", name]);
      git(["commit", "-q", "-m", message]);
      return git(["rev-parse", "HEAD"]).trim();
    };

    try {
      git(["init", "-q", "-b", "master"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "Test"]);
      commit("a.txt", "feat: a");
      git(["checkout", "-q", "-b", "topic"]);
      const tip = commit("api.txt", "fix: a crash");
      // What GitHub publishes as refs/pull/N/merge, and what the runner
      // leaves checked out.
      // On its own ref, as GitHub publishes it: the base branch does not
      // carry the merge, the runner just has it checked out.
      git(["checkout", "-q", "-b", "pull-7-merge", "master"]);
      git(["merge", "-q", "--no-ff", "-m", "Merge pull request #7", "topic"]);

      expect(branchCommits("master", tip, 500, git)).toEqual([
        { sha: tip, message: "fix: a crash", files: ["api.txt"] },
      ]);
      // The bug this guards: from HEAD the projection leads with a commit
      // merging never writes, carrying the branch's whole diff.
      const fromHead = branchCommits("master", "HEAD", 500, git);
      expect(fromHead?.map((c) => c.message)).toContain("Merge pull request #7");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hasCommit", () => {
  it("answers for a sha the checkout holds and one it does not", () => {
    const dir = mkdtempSync(join(tmpdir(), "has-commit-"));
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    try {
      git(["init", "-q", "-b", "master"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "Test"]);
      writeFileSync(join(dir, "a.txt"), "a\n");
      git(["add", "a.txt"]);
      git(["commit", "-q", "-m", "feat: a"]);
      const sha = git(["rev-parse", "HEAD"]).trim();

      expect(hasCommit(sha, git)).toBe(true);
      expect(hasCommit("0".repeat(40), git)).toBe(false);
      expect(hasCommit("", git)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("branchCommits, against a real repository", () => {
  // The injected runner above proves the parsing; this proves it against what
  // git actually prints for a message with blank lines in it.
  it("reads a branch's commits newest first, with their own files", () => {
    const dir = mkdtempSync(join(tmpdir(), "branch-commits-"));
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    const commit = (name: string, message: string) => {
      writeFileSync(join(dir, name), `${name}\n`);
      git(["add", name]);
      git(["commit", "-q", "-m", message]);
      return git(["rev-parse", "HEAD"]).trim();
    };

    try {
      git(["init", "-q", "-b", "master"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "Test"]);
      commit("a.txt", "feat: a");
      git(["checkout", "-q", "-b", "topic"]);
      const first = commit("api.txt", "feat: one\n\nwith a body\n\nRelease-As: 1.2.3");
      const second = commit("ui.txt", "fix: two");

      expect(branchCommits("master", "topic", 500, git)).toEqual([
        { sha: second, message: "fix: two", files: ["ui.txt"] },
        {
          sha: first,
          message: "feat: one\n\nwith a body\n\nRelease-As: 1.2.3",
          files: ["api.txt"],
        },
      ]);
      // Nothing new on the base side of the range.
      expect(branchCommits("topic", "master", 500, git)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
