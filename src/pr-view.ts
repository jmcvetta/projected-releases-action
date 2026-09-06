/**
 * pr-view presents a repository to release-please as it will look *after*
 * this pull request is merged.
 *
 * release-please computes from commits already on the target branch, and the
 * commits a merge adds are not commits until the merge happens. That is why
 * the answer cannot be had by running release-please as it stands, and why
 * the implementation this replaced mirrored release-please's rules in
 * another language instead.
 *
 * Every commit `Manifest.buildPullRequests()` reads arrives through one call,
 * `github.mergeCommitIterator(targetBranch, options)` (manifest.ts, "Collecting
 * commits since all latest releases"). Yielding synthetic commits ahead of the
 * real ones, and otherwise delegating, makes release-please compute the
 * post-merge answer itself: exact versions, exact changelog, and its own
 * decision about what does not release at all.
 *
 * How many synthetic commits there are is the whole difference between the
 * merge methods. A squash-merge writes one, built from the title and body; a
 * merge or a rebase puts the branch's own commits on the target branch
 * individually and release-please parses each of them. The construction is
 * the same either way — the caller says which commits merging writes.
 *
 * `GitHub` is exported from release-please's public index; `CommitSplit`,
 * `DefaultVersioningStrategy` and `DefaultChangelogNotes` are not. So this is
 * a view over public surface rather than a deep import into build/src.
 */

import type { Commit, GitHub } from "release-please";

/**
 * SyntheticCommit is the master commit a squash-merge of this pull request
 * would create: the title becomes the subject, the description becomes the
 * body, and the branch's changed files decide which components it touches.
 */
export interface SyntheticCommit {
  /** title is the pull request title, which squash-merge makes the subject. */
  title: string;
  /** body is the pull request description, which becomes the commit body. */
  body: string;
  /** files are the paths the branch changes, relative to the repository root. */
  files: string[];
  /** number is the pull request number, so changelog lines can link to it. */
  number: number;
  /** headSha is the commit the projection describes. */
  headSha: string;
  /** headBranch is the pull request's head branch. */
  headBranch: string;
  /** baseBranch is the branch the pull request targets. */
  baseBranch: string;
}

/**
 * BranchCommit is one commit merging would put on the target branch as
 * itself, which is what a merge-commit or rebase merge does with every commit
 * on the branch.
 *
 * The file list is the commit's own, not the pull request's, and that is the
 * whole reason this shape exists rather than reusing the pull request's one
 * list. release-please backfills a commit's files per commit in exactly this
 * case: `mergeCommitsGraphQL` only serves the pull request's file list to a
 * commit that is the *sole* commit its merge commit accounts for, which is a
 * squash-merge (measured, github.ts). A merge or a rebase leaves several
 * commits pointing at one merge commit, so each of them is backfilled from
 * the REST API with its own diff — and a version bump is attributed to the
 * package that commit touched, not to every package the branch touched.
 */
export interface BranchCommit {
  /** sha is the commit, so a changelog line can name it. */
  sha: string;
  /** message is the whole commit message, subject and body. */
  message: string;
  /** files are the paths this commit changes, relative to the repository
   * root. Its own, not the pull request's. */
  files: string[];
}

/**
 * SeamError reports that release-please never read the synthetic commit.
 *
 * This is the failure the whole preview has to be loud about. `release-please`
 * is pinned to an exact version, so the seam cannot move under a running
 * action — but an upgrade could move it, and the symptom would be a preview
 * reporting that nothing releases, which is also the most common true answer.
 * Nothing on screen would look wrong. Failing the step instead puts the
 * breakage on the dependency-bump pull request, where someone is already
 * looking.
 */
export class SeamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeamError";
  }
}

/**
 * PullRequestView is a release-please `GitHub` that has the pull request in
 * its history, plus the check that it was actually consulted.
 */
export interface PullRequestView {
  /** github is the view to hand to `Manifest.fromManifest`. */
  github: GitHub;
  /**
   * assertConsulted throws unless release-please read the synthetic commit
   * through the wrapped iterator. Call it after `buildPullRequests()`.
   */
  assertConsulted(): void;
}

/**
 * overrides are the files served from the pull request head rather than from
 * the target branch, keyed by repository path.
 *
 * release-please reads its config and manifest from the target branch, which
 * is right for it and wrong here: after the merge, master carries the pull
 * request's version of those files. A branch that adds a component to
 * release-please-config.json should preview as adding a component.
 */
export interface HeadOverrides {
  [path: string]: unknown;
}

/**
 * ReadHeadFile returns the pull request's version of a file, or undefined
 * when the pull request does not change it.
 *
 * release-please reads more than its own config from the target branch: a
 * release strategy reads the package file too — `release-type: node` opens
 * `package.json` to derive the component name. A pull request that *adds*
 * that file, which is what adopting release-please looks like, therefore
 * cannot be projected from the target branch alone: the file is not there
 * yet. Serving the head's copy is the same rule already applied to the config
 * and manifest, for the same reason — after the merge, that is the copy the
 * target branch has.
 */
export type ReadHeadFile = (path: string) => string | undefined;

/**
 * viewWithPullRequest wraps a real `GitHub` so release-please sees the merge
 * of this pull request as the newest commits on the target branch.
 *
 * `branch` is what merging writes when it is not one squashed commit: the
 * branch's own commits, newest first, as `mergeCommitIterator` orders them.
 * Given none, the squash-merge of `commit` is the single commit yielded,
 * which is the ordinary case.
 *
 * The wrap is an object whose prototype is the live instance, not a Proxy:
 * inherited methods keep working because every property they touch resolves
 * up the prototype chain, and the two overridden methods are plain own
 * properties shadowing theirs.
 */
export function viewWithPullRequest(
  base: GitHub,
  commit: SyntheticCommit,
  overrides: HeadOverrides = {},
  readHeadFile?: ReadHeadFile,
  branch?: readonly BranchCommit[],
): PullRequestView {
  if (typeof base.mergeCommitIterator !== "function") {
    throw new SeamError(
      "release-please's GitHub has no mergeCommitIterator; the seam this " +
        "preview wraps has moved. See src/pr-view.ts.",
    );
  }

  const pullRequest = {
    headBranchName: commit.headBranch,
    baseBranchName: commit.baseBranch,
    number: commit.number,
    title: commit.title,
    body: commit.body,
    labels: [],
    files: commit.files,
    sha: commit.headSha,
  };

  // The subject and body of the commit squash-merge would write. GitHub
  // prefills the squash commit message from the pull request title and
  // description, which is the whole reason the title is what release-please
  // will parse.
  const message = commit.body.trim()
    ? `${commit.title}\n\n${commit.body.trim()}`
    : commit.title;

  // Every synthetic commit carries the pull request, because GitHub
  // associates all of them with it: `associatedPullRequests` answers with
  // this pull request for a squashed commit, for a merge commit, and for
  // every commit a rebase replays. What that buys release-please is the
  // changelog's `(#7)` link — and `BEGIN_COMMIT_OVERRIDE` in the body, which
  // therefore replaces *each* of these messages rather than one of them.
  const synthetic: Commit[] =
    branch && branch.length > 0
      ? branch.map((c) => ({
          sha: c.sha,
          message: c.message,
          files: c.files,
          pullRequest,
        }))
      : [
          {
            sha: commit.headSha,
            message,
            files: commit.files,
            pullRequest,
          },
        ];

  let consulted = false;
  const view: GitHub = Object.create(base);

  view.mergeCommitIterator = async function* (
    targetBranch: string,
    options?: Parameters<GitHub["mergeCommitIterator"]>[1],
  ): AsyncGenerator<Commit> {
    consulted = true;
    for (const one of synthetic) yield one;
    yield* base.mergeCommitIterator(targetBranch, options);
  } as GitHub["mergeCommitIterator"];

  const paths = Object.keys(overrides);
  if (paths.length > 0) {
    view.getFileJson = async function <T>(
      path: string,
      branch: string,
    ): Promise<T> {
      if (Object.hasOwn(overrides, path)) return overrides[path] as T;
      return base.getFileJson<T>(path, branch);
    } as GitHub["getFileJson"];
  }

  if (readHeadFile) {
    view.getFileContentsOnBranch = async function (
      path: string,
      branch: string,
    ): Promise<unknown> {
      const content = readHeadFile(path);
      if (content === undefined) {
        return base.getFileContentsOnBranch(path, branch);
      }
      // The shape release-please's file cache returns. `parsedContent` is what
      // the strategies actually read; the rest is carried for callers that
      // inspect it.
      return {
        sha: "",
        mode: "100644",
        content: Buffer.from(content, "utf8").toString("base64"),
        parsedContent: content,
      };
    } as GitHub["getFileContentsOnBranch"];
  }

  return {
    github: view,
    assertConsulted() {
      if (!consulted) {
        throw new SeamError(
          "release-please built its release pull requests without reading " +
            "the synthetic commit: mergeCommitIterator was never called on " +
            "the wrapped view. The projection would silently describe the " +
            "target branch alone. See src/pr-view.ts.",
        );
      }
    },
  };
}
