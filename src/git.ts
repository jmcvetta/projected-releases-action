/**
 * git reads out of the checkout what the API would otherwise be asked for:
 * the pull request's changed files, the file list of each commit
 * release-please walks, and — for a repository that does not squash — the
 * commits merging will put on the target branch.
 *
 * The workflow checks the repository out with full history, so these are
 * local reads. Each is cheaper than its API counterpart by an order of
 * magnitude, and the last of the three has no cheap counterpart at all:
 * GitHub serves no per-commit file list for a pull request.
 */

import { execFileSync } from "node:child_process";
import type { BranchCommit } from "./pr-view.js";

/** Runner runs a git command and returns its stdout. Injected for tests. */
export type Runner = (args: string[]) => string;

const gitRunner: Runner = (args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/**
 * changedFiles lists the files the pull request adds to its base.
 *
 * Diffed from the merge base rather than from the base tip, so files that
 * merely arrived on the base branch since the branch started are not
 * attributed to the pull request.
 */
export function changedFiles(
  base: string,
  head: string,
  run: Runner = gitRunner,
): string[] {
  const mergeBase = run(["merge-base", base, head]).trim();
  return run(["diff", "--name-only", mergeBase, head])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * commitFileIndex maps each commit on `refs` to the files it changed, read
 * from the local checkout.
 *
 * release-please backfills a commit's file list with one serial REST call
 * whenever GitHub does not associate the commit with a merged pull request —
 * on a branch carrying direct pushes that is most of its history, and it was
 * about 60 seconds of a measured 183-second step (issue #54). One `git log`
 * answers the same question for every commit at once.
 *
 * A sha is right or it is absent: a commit's file list is a property of the
 * commit, not of the branch it was found on, so an index built from a
 * different ref than the one release-please walks is still correct for every
 * sha it holds. Anything it does not hold falls back to the API, which is why
 * the checks below can afford to be blunt.
 *
 * Returns undefined when the checkout cannot answer: no git, no such ref, or
 * a shallow clone, which `actions/checkout` produces by default and which
 * would otherwise index a fraction of the history and look complete doing it.
 */
export function commitFileIndex(
  refs: readonly string[],
  depth: number,
  run: Runner = gitRunner,
): Map<string, string[]> | undefined {
  try {
    if (run(["rev-parse", "--is-shallow-repository"]).trim() === "true") {
      return undefined;
    }
  } catch {
    return undefined;
  }
  for (const ref of refs) {
    const index = indexOf(ref, depth, run);
    if (index && index.size > 0) return index;
  }
  return undefined;
}

/**
 * branchCommits reads the commits merging would put on the target branch
 * individually, which is what a merge-commit or a rebase merge does.
 *
 * `<base>..<head>` rather than a diff from the merge base: the set that lands
 * is exactly what is reachable from the head and not from the base, which is
 * also what leaves out anything the branch merged *in* from the base. Newest
 * first, because that is the order `mergeCommitIterator` yields and the order
 * the changelog comes out in.
 *
 * The message and the file list are read in two passes over the same range.
 * `-z` is what makes the first one safe: it terminates each entry with a NUL,
 * which a commit message cannot contain, so a message holding anything at all
 * — blank lines, a line that looks like a sha — still parses.
 *
 * Returns undefined when the checkout cannot answer, for any of the reasons
 * `commitFileIndex` cannot: no git, no such ref, a shallow clone, a quoted
 * path. There is no half answer here. A branch commit served without its
 * files is attributed to no package and so releases nothing, which is the
 * quiet wrong answer this action exists to avoid; the caller falls back to
 * the API, or to saying it could not model the merge.
 */
export function branchCommits(
  base: string,
  head: string,
  depth: number,
  run: Runner = gitRunner,
): BranchCommit[] | undefined {
  try {
    if (run(["rev-parse", "--is-shallow-repository"]).trim() === "true") {
      return undefined;
    }
  } catch {
    return undefined;
  }

  const range = `${base}..${head}`;
  const files = indexOf(range, depth, run);
  if (!files) return undefined;

  let out: string;
  try {
    out = run(["log", "-z", `--max-count=${depth}`, "--format=%H%n%B", range]);
  } catch {
    return undefined;
  }

  const commits: BranchCommit[] = [];
  for (const entry of out.split("\0")) {
    if (!entry.trim()) continue;
    const newline = entry.indexOf("\n");
    const sha = (newline === -1 ? entry : entry.slice(0, newline)).trim();
    if (!sha) continue;
    // A sha the file index does not hold means the two passes disagree about
    // the range, and an empty list would be served confidently. See above.
    const own = files.get(sha);
    if (!own) return undefined;
    commits.push({
      sha,
      message: newline === -1 ? "" : entry.slice(newline + 1).trim(),
      files: own,
    });
  }
  return commits;
}

/**
 * indexOf reads one ref's history, or undefined when it cannot be read
 * faithfully.
 *
 * `--diff-merges=first-parent` is what makes a merge commit report files at
 * all: `git log --name-only` shows none for one by default, and an empty list
 * served confidently is worse than no index, since it attributes the commit to
 * no component. It is also the diff GitHub's own commit endpoint returns.
 *
 * Each commit is announced by a NUL-prefixed line so a path can never be
 * mistaken for a sha, and a quoted path abandons the whole index: git escapes
 * a path holding a control character or a quote, C-style, and unescaping it
 * here to save a few API calls would be a second parser to get wrong. Such a
 * repository simply pays what it paid before.
 */
function indexOf(
  ref: string,
  depth: number,
  run: Runner,
): Map<string, string[]> | undefined {
  let out: string;
  try {
    out = run([
      "-c",
      "core.quotePath=false",
      "log",
      `--max-count=${depth}`,
      "--name-only",
      "--diff-merges=first-parent",
      "--pretty=format:%x00%H",
      ref,
    ]);
  } catch {
    return undefined;
  }

  const index = new Map<string, string[]>();
  let files: string[] | undefined;
  for (const line of out.split("\n")) {
    if (line.startsWith("\0")) {
      files = [];
      index.set(line.slice(1).trim(), files);
      continue;
    }
    const path = line.trim();
    if (!path || !files) continue;
    if (path.startsWith('"')) return undefined;
    files.push(path);
  }
  return index;
}
