import { describe, expect, it } from "vitest";
import {
  isMergeMethod,
  mergeAdvisories,
  mergeCommitFor,
  mergeCommitMessage,
  projectedMethod,
} from "./merge-method.js";

const squashable = {
  allowSquash: true,
  allowMerge: true,
  allowRebase: true,
  squashTitle: "PR_TITLE",
  mergeTitle: "MERGE_MESSAGE",
  mergeMessage: "PR_TITLE",
};

const pr = {
  number: 7,
  title: "feat: add a widget",
  body: "Some description.\n\nRelease-As: 1.2.3",
  headLabel: "acme/topic",
  headSha: "abc1234",
};

describe("isMergeMethod", () => {
  it("accepts the four values and nothing else", () => {
    expect(isMergeMethod("auto")).toBe(true);
    expect(isMergeMethod("squash")).toBe(true);
    expect(isMergeMethod("fast-forward")).toBe(false);
  });
});

describe("projectedMethod", () => {
  it("models what the caller declared", () => {
    expect(projectedMethod({ method: "rebase" })).toBe("rebase");
    expect(projectedMethod({ method: "merge" })).toBe("merge");
  });

  it("models a squash-merge for a repository that allows one", () => {
    // The open question of issue #50, answered one way: a repository that
    // allows squash and merge-commit both — which is nearly all of them — is
    // projected as squash rather than shown two tables.
    expect(projectedMethod({ method: "auto", settings: squashable })).toBe(
      "squash",
    );
  });

  it("models the method a repository that cannot squash does allow", () => {
    expect(
      projectedMethod({
        method: "auto",
        settings: { ...squashable, allowSquash: false },
      }),
    ).toBe("merge");
    expect(
      projectedMethod({
        method: "auto",
        settings: { ...squashable, allowSquash: false, allowMerge: false },
      }),
    ).toBe("rebase");
  });

  it("models a squash-merge when the settings could not be read", () => {
    expect(projectedMethod({ method: "auto" })).toBe("squash");
  });

  it("models a squash-merge for a repository that allows nothing", () => {
    // Not reachable through the merge button, so there is no right answer --
    // only a wrong one to avoid, which is projecting a merge that cannot
    // happen and telling the reader the title does not matter.
    expect(
      projectedMethod({
        method: "auto",
        settings: {
          ...squashable,
          allowSquash: false,
          allowMerge: false,
          allowRebase: false,
        },
      }),
    ).toBe("squash");
  });
});

describe("mergeCommitMessage", () => {
  it("spells GitHub's default: a merge subject over the pull request title", () => {
    // Which matters because release-please's splitMessages splits on a blank
    // line before a Conventional Commit type, so this commit contributes the
    // title after all. Measured in merge-projection.test.ts.
    expect(mergeCommitMessage(pr)).toBe(
      "Merge pull request #7 from acme/topic\n\nfeat: add a widget",
    );
  });

  it("takes the subject from the title when the repository says so", () => {
    expect(
      mergeCommitMessage(pr, { mergeTitle: "PR_TITLE", mergeMessage: "BLANK" }),
    ).toBe("feat: add a widget");
  });

  it("takes the body from the description when the repository says so", () => {
    expect(
      mergeCommitMessage(pr, {
        mergeTitle: "MERGE_MESSAGE",
        mergeMessage: "PR_BODY",
      }),
    ).toBe(
      "Merge pull request #7 from acme/topic\n\nSome description.\n\nRelease-As: 1.2.3",
    );
  });

  it("writes a subject alone when the body is blank", () => {
    expect(
      mergeCommitMessage(
        { ...pr, body: "" },
        { mergeTitle: "MERGE_MESSAGE", mergeMessage: "PR_BODY" },
      ),
    ).toBe("Merge pull request #7 from acme/topic");
  });
});

describe("mergeCommitFor", () => {
  it("carries the whole pull request's files, which is its first-parent diff", () => {
    const commit = mergeCommitFor(pr, ["api/x.ts", "ui/y.ts"]);
    expect(commit.files).toEqual(["api/x.ts", "ui/y.ts"]);
    // A sha that is not a commit, and visibly not one.
    expect(commit.sha).toBe("abc1234-merge");
  });
});

describe("mergeAdvisories", () => {
  it("says nothing about an ordinary squash-merging repository", () => {
    expect(mergeAdvisories({ method: "auto", settings: squashable, commits: 3 })).toEqual([]);
  });

  it("says nothing merely because merge commits are also allowed", () => {
    // Nearly every repository allows all three, and a note on every pull
    // request is a note nobody reads.
    expect(mergeAdvisories({ method: "squash", commits: 2 })).toEqual([]);
  });

  it("says which question the comment is answering under a declared rebase", () => {
    const [note] = mergeAdvisories({ method: "rebase", modelled: "rebase" });
    expect(note).toContain("merge-method: rebase");
    expect(note).toContain("models the branch's own commits");
    expect(note).toContain("not the pull request title");
  });

  it("names the merge commit under a declared merge", () => {
    const [note] = mergeAdvisories({ method: "merge", modelled: "merge" });
    expect(note).toContain(", plus a merge commit above them");
  });

  it("says the repository cannot squash when that is what chose the method", () => {
    const [note] = mergeAdvisories({
      method: "auto",
      settings: { ...squashable, allowSquash: false },
      modelled: "merge",
    });
    expect(note).toContain("does not allow squash-merge");
    expect(note).toContain("models the branch's own commits");
  });

  it("says so loudly when the branch's commits could not be read", () => {
    // The projection then falls back to the squash answer, which is the one
    // thing the reader must not take for a description of their merge.
    const [note] = mergeAdvisories({ method: "merge", modelled: "squash" });
    expect(note).toContain("does not describe this merge");
    expect(note).toContain("fetch-depth: 0");
  });

  it("warns when a single commit will supply the subject instead of the title", () => {
    // COMMIT_OR_PR_TITLE prefills the squash subject from the branch's only
    // commit when there is one, so the title the gate checked is not the
    // subject release-please will parse.
    const [note] = mergeAdvisories({
      method: "auto",
      settings: { ...squashable, squashTitle: "COMMIT_OR_PR_TITLE" },
      commits: 1,
    });
    expect(note).toContain("COMMIT_OR_PR_TITLE");
  });

  it("does not warn about COMMIT_OR_PR_TITLE with more than one commit", () => {
    expect(
      mergeAdvisories({
        method: "auto",
        settings: { ...squashable, squashTitle: "COMMIT_OR_PR_TITLE" },
        commits: 2,
      }),
    ).toEqual([]);
  });

  it("says nothing when the settings could not be read", () => {
    expect(mergeAdvisories({ method: "auto" })).toEqual([]);
  });
});
