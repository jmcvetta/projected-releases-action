/**
 * merge-method decides which merge the projection models, and spells the one
 * commit a merge-commit merge writes that no branch of the pull request
 * holds.
 *
 * Three methods put different commits on the target branch, and release-please
 * parses whatever lands. A squash-merge contributes exactly one Conventional
 * Commit and it is the pull request title, which is the case this tool was
 * built for. A rebase replays the branch's commits unchanged, so the input is
 * the branch's commits parsed as they are. A merge commit does that too and
 * adds one commit of its own on top.
 *
 * That last commit is not the formality it looks like. GitHub's default
 * `merge_commit_title` is `MERGE_MESSAGE` — "Merge pull request #7 from
 * acme/topic", which parses as nothing — but its default
 * `merge_commit_message` is `PR_TITLE`, and release-please's `splitMessages`
 * splits a message on a blank line followed by a Conventional Commit type.
 * So the default merge commit contributes the pull request title after all,
 * exactly as a squash-merge does, *in addition to* the branch's own commits
 * (measured against release-please's `parseConventionalCommits`). A repository
 * that sets `merge_commit_message: BLANK` gets no such commit and a
 * repository that sets `merge_commit_title: PR_TITLE` gets the title twice.
 * None of that is guessable, so it is read from the repository.
 */

import type { RepositoryMergeSettings } from "./api.js";
import type { BranchCommit } from "./pr-view.js";

/** MergeMethod is how a caller says its repository merges. `auto` reads the
 * repository's settings to decide; the rest assert one, though `merge` still
 * reads how the repository spells a merge commit. */
export type MergeMethod = "auto" | "squash" | "merge" | "rebase";

/** MERGE_METHODS is every accepted value of the `merge-method` input. */
export const MERGE_METHODS: readonly MergeMethod[] = [
  "auto",
  "squash",
  "merge",
  "rebase",
];

/** ProjectedMethod is a merge method actually resolved, which is what the
 * projection models. `auto` is not one of them. */
export type ProjectedMethod = Exclude<MergeMethod, "auto">;

/** isMergeMethod narrows an input string to a MergeMethod. */
export function isMergeMethod(value: string): value is MergeMethod {
  return (MERGE_METHODS as readonly string[]).includes(value);
}

/** MergeContext is what the advisories are computed from. */
export interface MergeContext {
  /** method is the caller's declared merge method, or `auto`. */
  method: MergeMethod;
  /** settings are the repository's merge settings, when they were read. */
  settings?: RepositoryMergeSettings | undefined;
  /** commits is the number of commits on the pull request branch. */
  commits?: number | undefined;
  /**
   * modelled is the method the projection was actually built for, which is
   * `projectedMethod` unless reading the branch's commits failed. Absent
   * while the advisories are being computed before that is known.
   */
  modelled?: ProjectedMethod | undefined;
}

/**
 * projectedMethod resolves which merge the projection should model.
 *
 * Declared, it is what the caller declared. Under `auto` it is squash
 * whenever squash is available, which is the merge nearly every repository
 * offers and the one this comment's other half — "fix the title before
 * merging" — is about. Only a repository that *cannot* squash is projected
 * as something else, because there the squash answer describes a button
 * nobody can press.
 *
 * This is the deliberate half of the open question in issue #50: a repository
 * that allows squash and merge-commit both is projected as squash rather than
 * shown both outcomes. Two tables, most of the time identical, on every pull
 * request in almost every repository, is the shape of a comment nobody reads;
 * a repository that really merges the other way says so with `merge-method`.
 */
export function projectedMethod(context: MergeContext): ProjectedMethod {
  if (context.method !== "auto") return context.method;
  const settings = context.settings;
  if (!settings || settings.allowSquash) return "squash";
  if (settings.allowMerge) return "merge";
  if (settings.allowRebase) return "rebase";
  return "squash";
}

/** MergeCommitPullRequest is what the merge commit's message is spelled from. */
export interface MergeCommitPullRequest {
  number: number;
  title: string;
  body: string;
  /** headLabel is how GitHub names the head in the default merge subject,
   * `owner/branch`. Only ever prose: that subject parses as nothing whatever
   * it says, so an approximation here costs nothing. */
  headLabel: string;
  /** headSha is the pull request head, which the merge commit's second
   * parent is; the merge commit's own sha does not exist yet. */
  headSha: string;
}

/** MERGE_COMMIT_SHA_SUFFIX marks the synthetic merge commit's sha, which is
 * not a commit that exists: nothing may look it up, and a changelog line
 * carrying it is a line the reader can see is a projection. */
export const MERGE_COMMIT_SHA_SUFFIX = "-merge";

/**
 * mergeCommitMessage spells the merge commit a merge-commit merge writes.
 *
 * Nothing here tries to make the subject parse: "Merge pull request #7 from
 * acme/topic" is not a Conventional Commit and release-please says so in a
 * debug line. What matters is the *body*, which under GitHub's defaults is
 * the pull request title and which release-please splits out and parses as a
 * commit of its own.
 */
export function mergeCommitMessage(
  pr: MergeCommitPullRequest,
  settings?: Pick<RepositoryMergeSettings, "mergeTitle" | "mergeMessage">,
): string {
  const subject =
    settings?.mergeTitle === "PR_TITLE"
      ? pr.title
      : `Merge pull request #${pr.number} from ${pr.headLabel}`;
  const body =
    settings?.mergeMessage === "PR_BODY"
      ? pr.body.trim()
      : settings?.mergeMessage === "BLANK"
        ? ""
        : pr.title;
  return body ? `${subject}\n\n${body}` : subject;
}

/**
 * mergeCommitFor builds the synthetic merge commit, which sits above the
 * branch's own commits and carries the whole branch's diff.
 *
 * The files are the pull request's, and that is what a merge commit's diff
 * against its first parent is — the same list GitHub's commit endpoint
 * returns for one, and the same list `git log --diff-merges=first-parent`
 * reports.
 */
export function mergeCommitFor(
  pr: MergeCommitPullRequest,
  files: readonly string[],
  settings?: Pick<RepositoryMergeSettings, "mergeTitle" | "mergeMessage">,
): BranchCommit {
  return {
    sha: `${pr.headSha}${MERGE_COMMIT_SHA_SUFFIX}`,
    message: mergeCommitMessage(pr, settings),
    files: [...files],
  };
}

/**
 * mergeAdvisories lists what a reader has to know to read the projection
 * below it. An empty list is the ordinary case.
 *
 * A repository that merely *allows* a merge commit alongside squash gets no
 * warning: nearly every repository does, and a note on every pull request is
 * a note nobody reads. What is worth saying is that the comment is answering
 * a different question from the usual one — under a merge or a rebase the
 * title is not the input, so the title's type explains nothing and the
 * malformed-title gate does not apply — or that it could not answer the
 * question the repository actually asks.
 */
export function mergeAdvisories(context: MergeContext): string[] {
  const advisories: string[] = [];
  const wanted = projectedMethod(context);
  // Before the branch's commits are known, the projection is assumed to be
  // the one that was wanted; `modelled` corrects that afterwards.
  const modelled = context.modelled ?? wanted;

  if (wanted !== "squash") {
    const why =
      context.method === "auto"
        ? "This repository does not allow squash-merge"
        : `This repository is configured as \`merge-method: ${wanted}\``;
    const how =
      wanted === "merge"
        ? ", plus a merge commit above them"
        : ", which a rebase replays onto the target branch unchanged";
    advisories.push(
      modelled === wanted
        ? `- ${why}, so the projection below models the branch's own commits${how}.` +
            " release-please parses those, not the pull request title, so the" +
            " title's type does not decide what releases and a title that is" +
            " not a Conventional Commit is not a problem here."
        : `- ${why}, but the branch's commits could not be read — the` +
            " checkout is shallow or absent and the API could not stand in" +
            " for it. **The projection below models a squash-merge and does" +
            " not describe this merge.** Check the repository out with" +
            " `fetch-depth: 0`.",
    );
    return advisories;
  }

  const settings = context.settings;
  if (!settings) return advisories;

  if (settings.squashTitle === "COMMIT_OR_PR_TITLE" && context.commits === 1) {
    advisories.push(
      "- This repository's squash setting is `COMMIT_OR_PR_TITLE` and the" +
        " branch has a single commit, so GitHub will prefill the squash" +
        " subject from **that commit's message**, not from this title. The" +
        " merge box is editable; the projection below assumes the title.",
    );
  }

  return advisories;
}
