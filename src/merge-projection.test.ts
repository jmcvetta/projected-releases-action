/**
 * These tests drive real release-please over a fixture repository that merges
 * rather than squashes, which is the thing issue #50 asked to have measured
 * before it was modelled.
 *
 * Two of the answers below were not guessable from the shape of the feature:
 *
 * - A merge commit contributes the pull request title after all. GitHub's
 *   default `merge_commit_message` is `PR_TITLE`, and release-please's
 *   `splitMessages` splits a message on a blank line followed by a
 *   Conventional Commit type — so "Merge pull request #7 from acme/topic"
 *   parses as nothing and the title below it parses as a commit, *on top of*
 *   the branch's own commits. A repository merging that way releases from
 *   both.
 * - Every commit is attributed by its own files, not the pull request's.
 *   `mergeCommitsGraphQL` serves the pull request's file list only to a
 *   commit that is the sole commit its merge commit accounts for — a
 *   squash-merge — and backfills the rest one commit at a time.
 *
 * Both are asserted here rather than read off the source, for the reason
 * project.test.ts gives at length.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { setLogger } from "release-please";
import { fakeScm } from "./fake-scm.fixture.js";
import { mergeCommitFor } from "./merge-method.js";
import type { BranchCommit } from "./pr-view.js";
import { project } from "./project.js";
import type { Projection } from "./project.js";
import { render } from "./render.js";

beforeAll(() => {
  const quiet = () => {};
  setLogger({
    debug: quiet,
    info: quiet,
    warn: quiet,
    error: quiet,
    trace: quiet,
    fatal: quiet,
  } as Parameters<typeof setLogger>[0]);
});

const CONFIG = {
  "separate-pull-requests": true,
  packages: {
    api: {
      "release-type": "simple",
      component: "acme-api",
      "include-component-in-tag": true,
      "tag-separator": "@",
    },
    ui: {
      "release-type": "simple",
      component: "acme-ui",
      "include-component-in-tag": true,
      "tag-separator": "@",
    },
  },
};
const MANIFEST = { api: "2.4.1", ui: "1.0.0" };

const PR = {
  number: 7,
  title: "chore: tidy up",
  body: "",
  headLabel: "acme/topic",
  headSha: "abcdef1234567890",
};

/** commit is one commit on the pull request's branch, with its own files. */
function commit(message: string, files: string[]): BranchCommit {
  return { sha: `sha${message.length}${files.length}`, message, files };
}

/**
 * run projects one pull request against the fixture repository, with the
 * branch's commits as what merging writes.
 */
async function run(
  branch: readonly BranchCommit[],
  pr: Partial<typeof PR> = {},
  files = branch.flatMap((c) => c.files),
): Promise<Projection> {
  const full = { ...PR, ...pr };
  return project({
    github: fakeScm({ config: CONFIG, manifest: MANIFEST }),
    config: CONFIG,
    manifest: MANIFEST,
    branch,
    commit: {
      title: full.title,
      body: full.body,
      files,
      number: full.number,
      headSha: full.headSha,
      headBranch: "topic",
      baseBranch: "master",
    },
  });
}

/** versions is the projected version per component, for terse assertions. */
function versions(projection: Projection): Record<string, string> {
  return Object.fromEntries(
    projection.projected.map((r) => [r.component, r.version]),
  );
}

describe("a rebase merge, where the branch's commits land unchanged", () => {
  it("releases from the commits, not from the title", () => {
    // The title is a `chore:`. Under a squash-merge that releases nothing at
    // all; here it is not an input.
    return expect(
      run([commit("feat: a widget", ["api/x.ts"])]).then(versions),
    ).resolves.toEqual({ "acme-api": "2.5.0" });
  });

  it("attributes each commit to the package its own files touch", async () => {
    // The measurement the per-commit file list exists for: one list for the
    // whole pull request would bump both components by the larger of the two.
    const p = await run([
      commit("feat: a widget", ["api/x.ts"]),
      commit("fix: a button", ["ui/y.ts"]),
    ]);
    expect(versions(p)).toEqual({ "acme-api": "2.5.0", "acme-ui": "1.0.1" });
  });

  it("takes the largest bump a package's own commits ask for", async () => {
    const p = await run([
      commit("fix: a typo", ["api/x.ts"]),
      commit("feat!: a new shape", ["api/y.ts"]),
    ]);
    expect(versions(p)).toEqual({ "acme-api": "3.0.0" });
  });

  it("releases nothing when no commit carries a releasing type", async () => {
    const p = await run([
      commit("chore: tidy", ["api/x.ts"]),
      commit("ci: bump the runner", ["api/y.ts"]),
    ]);
    expect(p.projected).toEqual([]);
  });

  it("honours a Release-As trailer in a commit rather than in the body", async () => {
    // Under a squash-merge the note is read from the description, because
    // that is what becomes the commit body. Here the commit messages are the
    // commit bodies.
    const p = await run([
      commit("feat: a widget\n\nRelease-As: 9.9.9", ["api/x.ts"]),
    ]);
    expect(versions(p)).toEqual({ "acme-api": "9.9.9" });
    expect(p.releaseAs).toBe("9.9.9");
    expect(p.ignoredReleaseAs).toBeUndefined();
  });

  it("writes a changelog line per commit", async () => {
    const p = await run([
      commit("feat: a widget", ["api/x.ts"]),
      commit("fix: a crash", ["api/y.ts"]),
    ]);
    const notes = p.projected[0]?.notes ?? "";
    expect(notes).toContain("a widget");
    expect(notes).toContain("a crash");
  });
});

describe("a merge commit, which is the branch's commits and one more", () => {
  /** merged is what a merge-commit merge writes: the merge commit over the
   * branch's own, newest first. */
  function merged(
    branch: readonly BranchCommit[],
    pr: Partial<typeof PR>,
    settings?: { mergeTitle: string; mergeMessage: string },
  ): BranchCommit[] {
    const files = branch.flatMap((c) => c.files);
    return [mergeCommitFor({ ...PR, ...pr }, files, settings), ...branch];
  }

  it("releases from the title as well, under GitHub's default settings", async () => {
    // Not a formality: `merge_commit_message: PR_TITLE` puts the title in the
    // merge commit's body, and splitMessages parses it as a commit of its
    // own. So a merge-commit repository releases from the title *and* from
    // the branch — which a projection modelling only the branch would miss.
    const p = await run(
      merged([commit("chore: tidy", ["api/x.ts"])], { title: "feat: a widget" }, {
        mergeTitle: "MERGE_MESSAGE",
        mergeMessage: "PR_TITLE",
      }),
      { title: "feat: a widget" },
    );
    expect(versions(p)).toEqual({ "acme-api": "2.5.0" });
  });

  it("releases nothing from the title when the body is blank", async () => {
    const p = await run(
      merged([commit("chore: tidy", ["api/x.ts"])], { title: "feat: a widget" }, {
        mergeTitle: "MERGE_MESSAGE",
        mergeMessage: "BLANK",
      }),
      { title: "feat: a widget" },
    );
    expect(p.projected).toEqual([]);
  });

  it("gives the merge commit the whole branch's diff", async () => {
    // A merge commit's diff against its first parent is the whole branch, so
    // its own Conventional Commit reaches every package the branch touched —
    // while the branch's commits each reach only their own.
    const p = await run(
      merged(
        [commit("chore: tidy", ["api/x.ts", "ui/y.ts"])],
        { title: "fix: a crash" },
        { mergeTitle: "MERGE_MESSAGE", mergeMessage: "PR_TITLE" },
      ),
      { title: "fix: a crash" },
    );
    expect(versions(p)).toEqual({ "acme-api": "2.4.2", "acme-ui": "1.0.1" });
  });

  it("drops a Release-As the description carries under a merge subject", async () => {
    // Measured, and not obvious: `merge_commit_message: PR_BODY` does put the
    // trailer in the merge commit, but "Merge pull request #7 from …" is not
    // a Conventional Commit, so the *whole* message fails to parse and the
    // footer goes with it. release-please says nothing about that, which is
    // the same silent failure a rule below the trailer causes.
    const pr = { title: "feat: a widget", body: "Release-As: 4.5.6" };
    const p = await run(
      merged([commit("feat: a widget", ["api/x.ts"])], pr, {
        mergeTitle: "MERGE_MESSAGE",
        mergeMessage: "PR_BODY",
      }),
      pr,
    );
    expect(versions(p)).toEqual({ "acme-api": "2.5.0" });
    // The comment says so rather than leaving it to be discovered after the
    // merge, which is what the ignored-note warning is for.
    expect(p.ignoredReleaseAs).toBe("4.5.6");
  });

  it("honours it when the merge subject is the title, which does parse", async () => {
    const pr = { title: "feat: a widget", body: "Release-As: 4.5.6" };
    const p = await run(
      merged([commit("chore: tidy", ["api/x.ts"])], pr, {
        mergeTitle: "PR_TITLE",
        mergeMessage: "PR_BODY",
      }),
      pr,
    );
    expect(versions(p)).toEqual({ "acme-api": "4.5.6" });
    expect(p.ignoredReleaseAs).toBeUndefined();
  });
});

describe("what the comment says when the commits are the input", () => {
  it("does not explain an empty answer with the title's type", async () => {
    const branch = [commit("chore: tidy", ["api/x.ts"])];
    const body = render(await run(branch, { title: "not conventional at all" }), {
      title: "not conventional at all",
      malformed: false,
      commitMessages: branch.map((c) => c.message),
    });
    expect(body).toContain("None — no commit on this branch produces a release.");
    expect(body).not.toContain("produces no release.\n");
  });

  it("reads a merge commit's body, where the title reaches release-please", async () => {
    // The merge commit's subject parses as nothing and its body is the title.
    // Reading only subjects would call this branch typeless and explain the
    // answer with the wrong sentence.
    const branch = [
      {
        sha: "m",
        message: "Merge pull request #7 from acme/topic\n\nfeat: a widget",
        files: ["docs/readme.md"],
      },
    ];
    const body = render(await run(branch), {
      title: "feat: a widget",
      malformed: false,
      commitMessages: branch.map((c) => c.message),
    });
    expect(body).not.toContain("no commit on this branch produces a release");
  });

  it("still names the files when nothing the branch touched is a package", async () => {
    const branch = [commit("feat: a widget", ["docs/readme.md"])];
    const body = render(await run(branch), {
      title: "chore: tidy up",
      malformed: false,
      commitMessages: branch.map((c) => c.message),
    });
    expect(body).toContain("no changed file is under a package path");
    expect(body).toContain("`docs`");
  });
});
