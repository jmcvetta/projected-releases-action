import { beforeAll, describe, expect, it } from "vitest";
import { GitHub, setLogger } from "release-please";
import type { Commit, GitHub as GitHubType } from "release-please";
import { commitSource, UPSTREAM_BATCH_SIZE, walkPageSize } from "./commits.js";
import { startFakeGitHub } from "./fake-github-server.fixture.js";
import { project } from "./project.js";

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

/** history is a client whose walk can be watched: what each walk was started
 * with, and which commits it actually handed out. */
function history(shas: string[]): {
  github: GitHubType;
  walks: { targetBranch: string; options: unknown }[];
  yielded: string[];
  backfilled: string[];
} {
  const state = {
    walks: [] as { targetBranch: string; options: unknown }[],
    yielded: [] as string[],
    backfilled: [] as string[],
    github: undefined as unknown as GitHubType,
  };
  state.github = {
    async *mergeCommitIterator(
      targetBranch: string,
      options?: unknown,
    ): AsyncGenerator<Commit> {
      state.walks.push({ targetBranch, options });
      for (const sha of shas) {
        state.yielded.push(sha);
        yield { sha, message: "fix: a thing", files: [] };
      }
    },
    async getCommitFiles(sha: string): Promise<string[]> {
      state.backfilled.push(sha);
      return [`from-api/${sha}.ts`];
    },
  } as unknown as GitHubType;
  return state as never;
}

/** failing is a client whose walk hands out `shas` and then throws, which is
 * what a GraphQL page that fails partway through a history looks like. */
function failing(shas: string[], error: Error): { github: GitHubType } {
  return {
    github: {
      async *mergeCommitIterator(): AsyncGenerator<Commit> {
        for (const sha of shas) yield { sha, message: "fix: a thing", files: [] };
        throw error;
      },
    } as unknown as GitHubType,
  };
}

/** shas names `count` commits, so a walk long enough to be capped can be
 * written without spelling one out per line. */
function shas(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `c${i}`);
}

async function walk(
  github: GitHubType,
  options?: Parameters<GitHubType["mergeCommitIterator"]>[1],
  stopAfter = Number.POSITIVE_INFINITY,
  targetBranch = "master",
): Promise<string[]> {
  const out: string[] = [];
  for await (const commit of github.mergeCommitIterator(
    targetBranch,
    options,
  )) {
    out.push(commit.sha);
    if (out.length >= stopAfter) break;
  }
  return out;
}

describe("the cached walk", () => {
  it("reads the history once and replays it to the second pass", async () => {
    const client = history(["a", "b", "c"]);
    const source = commitSource(client.github);

    expect(await walk(source)).toEqual(["a", "b", "c"]);
    expect(await walk(source)).toEqual(["a", "b", "c"]);
    expect(client.walks).toHaveLength(1);
    expect(client.yielded).toEqual(["a", "b", "c"]);
  });

  it("continues the upstream walk the first pass stopped short of", async () => {
    // release-please stops by breaking out of a `for await`, which calls
    // return() on the generator it is reading. Forwarding that upstream --
    // which `yield*` does -- would close the shared walk for good, and the
    // second pass would silently see only what the first one happened to
    // need.
    const client = history(["a", "b", "c", "d"]);
    const source = commitSource(client.github);

    expect(await walk(source, undefined, 2)).toEqual(["a", "b"]);
    expect(await walk(source)).toEqual(["a", "b", "c", "d"]);
    expect(client.walks).toHaveLength(1);
    expect(client.yielded).toEqual(["a", "b", "c", "d"]);
  });

  it("answers a walk asking for a different depth from the same read", async () => {
    // The two questions one pass asks: `Manifest.fromConfig` resolves the
    // last release at 250, then `buildPullRequests` walks at 500. Keyed on
    // the options rather than the branch, the second was a fresh walk over
    // pages the first had already fetched -- twice per projection.
    const client = history(["a", "b"]);
    const source = commitSource(client.github);

    await walk(source, { maxResults: 250 });
    await walk(source, { maxResults: 500, backfillFiles: true, batchSize: 100 });
    expect(client.walks).toHaveLength(1);
    expect(client.yielded).toEqual(["a", "b"]);
  });

  it("starts that read backfilled and at the batch size it was given", async () => {
    // The shared walk is the one whose commits everything else is served
    // from, so it has to carry the file lists the backfilling consumer needs:
    // a commit fetched without them cannot be upgraded afterwards. Its cap is
    // not written here -- it is each consumer's, applied at replay.
    const client = history(["a"]);
    const source = commitSource(client.github, { batchSize: 100 });

    await walk(source, { maxResults: 250 });
    expect(client.walks[0]?.options).toEqual({
      backfillFiles: true,
      batchSize: 100,
    });
  });

  it("stops where release-please would, at a whole page", async () => {
    // release-please checks its cap between pages, not between commits, so a
    // walk overshoots to the end of the page the cap falls in. What reads
    // those extra commits is `latestReleaseVersion`, which accepts a release
    // only if its sha is one the walk handed over -- so a replay stopping
    // anywhere else answers a question nobody asked.
    const client = history(shas(40));
    const source = commitSource(client.github);

    expect(await walk(source, { maxResults: 25 })).toHaveLength(30);
    expect(await walk(source, { maxResults: 25, batchSize: 100 })).toHaveLength(
      40,
    );
    expect(await walk(source, { maxResults: 25, batchSize: 5 })).toHaveLength(
      25,
    );
    expect(client.walks).toHaveLength(1);
  });

  it("reads no further than the deepest consumer asked for", async () => {
    // Nothing caps the shared walk, so what bounds it is that it is pulled a
    // commit at a time: a page nobody reads is a page never fetched.
    const client = history(shas(40));
    const source = commitSource(client.github);

    await walk(source, { maxResults: 10 });
    expect(client.yielded).toHaveLength(10);
  });

  it("delegates a walk over another branch, with what it asked for", async () => {
    // The one call that must not be given the shared walk's options: it is
    // not the shared walk, and nothing replays it.
    const client = history(["a", "b"]);
    const source = commitSource(client.github, { batchSize: 100 });

    await walk(source, undefined, Number.POSITIVE_INFINITY, "master");
    await walk(source, { maxResults: 50 }, Number.POSITIVE_INFINITY, "next");
    expect(client.walks).toEqual([
      { targetBranch: "master", options: { backfillFiles: true, batchSize: 100 } },
      { targetBranch: "next", options: { maxResults: 50 } },
    ]);
  });

  it("pages at the size release-please resolved, whatever it was given", async () => {
    // A repository can write anything in `commit-batch-size`, and
    // release-please hands the value back rather than validating it.
    expect(walkPageSize(25)).toBe(25);
    // What release-please's own `commitBatchSize || DEFAULT` resolves a zero
    // to, and what the rest are worth to a query whose `$num` is an `Int!`.
    expect(walkPageSize(0)).toBe(UPSTREAM_BATCH_SIZE);
    expect(walkPageSize(undefined)).toBe(UPSTREAM_BATCH_SIZE);
    expect(walkPageSize("auto")).toBe(UPSTREAM_BATCH_SIZE);
    expect(walkPageSize(2.5)).toBe(UPSTREAM_BATCH_SIZE);
    expect(walkPageSize(Number.NaN)).toBe(UPSTREAM_BATCH_SIZE);
  });

  it("replays at that size, so a walk given no usable one pages at ten", async () => {
    // Safe to drive because the loop counts pages: a size that fits nothing
    // ends the walk. Without that, this test would not fail on a page of
    // `NaN` commits -- it would hang, on a loop no timeout can reach.
    const client = history(shas(40));
    const source = commitSource(client.github);

    const seen = await walk(source, {
      maxResults: 25,
      batchSize: "auto",
    } as unknown as Parameters<GitHubType["mergeCommitIterator"]>[1]);
    expect(seen).toHaveLength(30);
  });

  it("hands a failed read to the next consumer, not a short history", async () => {
    // A generator that throws is finished, so the commit after the failure
    // looks exactly like the end of the branch. The second pass would then
    // project from half a history and say nothing about it.
    const client = failing(["a", "b"], new Error("graphql exploded"));
    const source = commitSource(client.github);

    await expect(walk(source)).rejects.toThrow("graphql exploded");
    await expect(walk(source)).rejects.toThrow("graphql exploded");
  });

  it("still serves what it read before the failure", async () => {
    // The cache is read before the failure is raised, so a consumer whose cap
    // stops short of the commit that failed still gets its history: the
    // failure belongs to the read that went past it, not to the branch. Raise
    // it first and the shallower consumer is refused a walk it would have
    // completed.
    const client = failing(["a", "b"], new Error("graphql exploded"));
    const source = commitSource(client.github);

    await expect(walk(source)).rejects.toThrow("graphql exploded");
    expect(await walk(source, { maxResults: 2, batchSize: 2 })).toEqual([
      "a",
      "b",
    ]);
    expect(await walk(source, { maxResults: 1, batchSize: 1 })).toEqual(["a"]);
  });

  it("hands the client back untouched when the seam has moved", () => {
    // pr-view.ts raises the error for this; here it is only important that
    // nothing wraps a method that is not there.
    const moved = {} as unknown as GitHubType;
    expect(commitSource(moved)).toBe(moved);
  });
});

describe("the commit file lists", () => {
  it("come from the local index when it knows the commit", async () => {
    const client = history(["a"]);
    const source = commitSource(client.github, {
      files: (sha) => (sha === "a" ? ["local/a.ts"] : undefined),
    });
    expect(await source.getCommitFiles("a")).toEqual(["local/a.ts"]);
    expect(client.backfilled).toEqual([]);
  });

  it("fall back to the API for a commit it does not", async () => {
    const client = history(["a"]);
    const source = commitSource(client.github, { files: () => undefined });
    expect(await source.getCommitFiles("z")).toEqual(["from-api/z.ts"]);
    expect(client.backfilled).toEqual(["z"]);
  });
});

/**
 * The rest of this file drives real release-please over real HTTP.
 *
 * What it is here to catch is the receiver. release-please backfills a file
 * list by calling `this.getCommitFiles` from inside its own iterator, so an
 * override installed on a wrapper only ever runs if the wrapper is the
 * receiver that iterator was started with. Get that wrong and everything
 * still works — the API answers, the projection is right, and the index this
 * builds is simply never consulted. Nothing fails; the action is just slow
 * again.
 */

const CONFIG = {
  "separate-pull-requests": true,
  packages: {
    api: { "release-type": "simple", component: "acme-api" },
    ui: { "release-type": "simple", component: "acme-ui" },
  },
};
const MANIFEST = { api: "2.4.1", ui: "1.0.0" };
const RELEASE_SHA = "0".repeat(40);

/**
 * projectOverHttp projects one pull request against a branch holding a single
 * direct-push commit, whose file list the API reports under `ui/`.
 *
 * The index, when given, says `api/` instead. They disagree on purpose: the
 * component that comes out names which of the two release-please read.
 */
async function projectOverHttp(
  files?: (sha: string) => string[] | undefined,
): Promise<{ pending: string[]; requests: string[] }> {
  const fake = await startFakeGitHub({
    owner: "acme",
    repo: "widgets",
    branch: "master",
    files: {
      "release-please-config.json": JSON.stringify(CONFIG),
      ".release-please-manifest.json": JSON.stringify(MANIFEST),
    },
    commits: [
      {
        sha: "feed01",
        message: "feat: a thing",
        files: ["ui/x.ts"],
        unassociated: true,
      },
      { sha: RELEASE_SHA, message: "chore: release", files: [] },
    ],
    releases: [
      { tagName: "acme-api-v2.4.1", sha: RELEASE_SHA },
      { tagName: "acme-ui-v1.0.0", sha: RELEASE_SHA },
    ],
  });

  try {
    const github = await GitHub.create({
      owner: "acme",
      repo: "widgets",
      defaultBranch: "master",
      token: "fake",
      apiUrl: fake.url,
      graphqlUrl: fake.url,
    });
    const projection = await project({
      github,
      config: CONFIG,
      manifest: MANIFEST,
      ...(files ? { commitFiles: files } : {}),
      commit: {
        title: "docs: nothing releasable",
        body: "",
        files: ["README.md"],
        number: 7,
        headSha: "c".repeat(40),
        headBranch: "topic",
        baseBranch: "master",
      },
    });
    return {
      pending: projection.pending.map((release) => release.component),
      requests: [...fake.requests],
    };
  } finally {
    await fake.close();
  }
}

describe("the file lists release-please reads", () => {
  it("come from the index, and decide the answer", async () => {
    const seen = await projectOverHttp((sha) =>
      sha === "feed01" ? ["api/x.ts"] : undefined,
    );
    expect(seen.pending).toEqual(["acme-api"]);
    expect(seen.requests).not.toContain("GET /repos/acme/widgets/commits/feed01");
  });

  it("fall back to a request per commit when the index has none", async () => {
    const seen = await projectOverHttp();
    expect(seen.pending).toEqual(["acme-ui"]);
    expect(seen.requests).toContain("GET /repos/acme/widgets/commits/feed01");
  });
});

/**
 * Plain mode asks the branch's history two different questions per pass, and
 * that is where the cost this file exists to remove was hiding.
 *
 * `Manifest.fromConfig` resolves the last release before anything else,
 * walking at 250 with no batch size; `buildPullRequests` then walks at 500,
 * backfilled, in pages of a hundred. Manifest mode never makes the first
 * call, and the walk-counting test that drove a real `Manifest` -- the one in
 * project.test.ts -- drove manifest mode. The tests above drive this file
 * directly, which is why one of them used to assert the second walk as the
 * contract. Nothing asked the caller that asks twice, so a plain-mode
 * repository paid for three walks per pull request with the suite reporting
 * one.
 */
describe("a plain-mode projection", () => {
  /** projectPlain projects one pull request against a single-package
   * repository with no config or manifest file, and reports what its history
   * was asked for. */
  async function projectPlain(): Promise<{
    projected: string[];
    graphql: string[];
  }> {
    const fake = await startFakeGitHub({
      owner: "acme",
      repo: "widgets",
      branch: "master",
      files: {
        "package.json": JSON.stringify({ name: "widgets", version: "2.4.1" }),
      },
      commits: [
        { sha: "feed01", message: "fix: a thing", files: ["src/x.ts"] },
        { sha: RELEASE_SHA, message: "chore: release", files: [] },
      ],
      releases: [{ tagName: "v2.4.1", sha: RELEASE_SHA }],
    });

    try {
      const github = await GitHub.create({
        owner: "acme",
        repo: "widgets",
        defaultBranch: "master",
        token: "fake",
        apiUrl: fake.url,
        graphqlUrl: fake.url,
      });
      const projection = await project({
        github,
        config: {},
        manifest: {},
        plain: { releaseType: "node" },
        commit: {
          title: "feat: a thing",
          body: "",
          files: ["src/x.ts"],
          number: 7,
          headSha: "c".repeat(40),
          headBranch: "topic",
          baseBranch: "master",
        },
      });
      return {
        projected: projection.projected.map((release) => release.version),
        graphql: [...fake.graphql],
      };
    } finally {
      await fake.close();
    }
  }

  it("reads the branch's history exactly once", async () => {
    const seen = await projectPlain();
    expect(seen.projected).toEqual(["2.5.0"]);
    expect(seen.graphql.filter((name) => name === "pullRequestsSince")).toEqual(
      ["pullRequestsSince"],
    );
  });
});
