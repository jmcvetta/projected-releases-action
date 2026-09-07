import { beforeAll, describe, expect, it } from "vitest";
import { GitHub, setLogger } from "release-please";
import type { Commit, GitHub as GitHubType } from "release-please";
import { historySource } from "./history.js";
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

/** history is a client whose walk can be watched: how many times it was
 * started, and which commits it actually handed out. */
function history(shas: string[]): {
  github: GitHubType;
  walks: number;
  yielded: string[];
  backfilled: string[];
} {
  const state = {
    walks: 0,
    yielded: [] as string[],
    backfilled: [] as string[],
    github: undefined as unknown as GitHubType,
  };
  state.github = {
    async *mergeCommitIterator(): AsyncGenerator<Commit> {
      state.walks += 1;
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

async function walk(
  github: GitHubType,
  options?: Parameters<GitHubType["mergeCommitIterator"]>[1],
  stopAfter = Number.POSITIVE_INFINITY,
): Promise<string[]> {
  const out: string[] = [];
  for await (const commit of github.mergeCommitIterator("master", options)) {
    out.push(commit.sha);
    if (out.length >= stopAfter) break;
  }
  return out;
}

describe("the cached walk", () => {
  it("reads the history once and replays it to the second pass", async () => {
    const client = history(["a", "b", "c"]);
    const source = historySource(client.github);

    expect(await walk(source)).toEqual(["a", "b", "c"]);
    expect(await walk(source)).toEqual(["a", "b", "c"]);
    expect(client.walks).toBe(1);
    expect(client.yielded).toEqual(["a", "b", "c"]);
  });

  it("continues the upstream walk the first pass stopped short of", async () => {
    // release-please stops by breaking out of a `for await`, which calls
    // return() on the generator it is reading. Forwarding that upstream --
    // which `yield*` does -- would close the shared walk for good, and the
    // second pass would silently see only what the first one happened to
    // need.
    const client = history(["a", "b", "c", "d"]);
    const source = historySource(client.github);

    expect(await walk(source, undefined, 2)).toEqual(["a", "b"]);
    expect(await walk(source)).toEqual(["a", "b", "c", "d"]);
    expect(client.walks).toBe(1);
    expect(client.yielded).toEqual(["a", "b", "c", "d"]);
  });

  it("gives a walk asking a different question a cache of its own", async () => {
    // Not one cache and a re-read for everything else. In plain mode
    // release-please asks two commit questions -- `latestReleaseVersion` wants
    // 250 commits with no file lists, `buildPullRequests` wants the deep
    // backfilling walk -- and the cheap one is asked first. A single-slot
    // cache is claimed by it, and the expensive walk is then paid for twice.
    const client = history(["a", "b"]);
    const source = historySource(client.github);

    await walk(source, { maxResults: 500 });
    await walk(source, { maxResults: 50 });
    expect(client.walks).toBe(2);

    // And each of them is now answered from its own cache.
    await walk(source, { maxResults: 500 });
    await walk(source, { maxResults: 50 });
    expect(client.walks).toBe(2);
  });

  it("tells a later consumer that the walk failed, rather than ending it", async () => {
    // A walk that threw is over: pulling a completed generator again answers
    // `done`, which would look to the second pass exactly like a short
    // history. That is a missing release boundary and a version computed over
    // the wrong span, with nothing on screen wrong.
    //
    // Defensive rather than reached today: pass 1 is uncaught, so a walk that
    // throws ends the run before pass 2 exists. It is the second pass being
    // the caught one -- project.ts turns its failure into an empty `pending`
    // and a line on stderr -- that makes a silently short walk there the
    // expensive mistake.
    const failing = {
      async *mergeCommitIterator(): AsyncGenerator<Commit> {
        yield { sha: "a", message: "fix: a thing", files: [] };
        throw new Error("boom");
      },
    } as unknown as GitHubType;
    const source = historySource(failing);

    const attempt = async (): Promise<{ got: string[]; threw: unknown }> => {
      const got: string[] = [];
      try {
        for await (const commit of source.mergeCommitIterator("master")) {
          got.push(commit.sha);
        }
      } catch (error) {
        return { got, threw: error };
      }
      return { got, threw: undefined };
    };

    expect(await attempt()).toMatchObject({ got: ["a"], threw: expect.any(Error) });
    // And the second consumer is handed what the walk did reach before the
    // error, then the error itself -- the failure is at the point the walk
    // actually stopped, not at the front of it.
    expect(await attempt()).toMatchObject({ got: ["a"], threw: expect.any(Error) });
  });

  it("hands the client back untouched when the seam has moved", () => {
    // pr-view.ts raises the error for this; here it is only important that
    // nothing wraps a method that is not there.
    const moved = {} as unknown as GitHubType;
    expect(historySource(moved)).toBe(moved);
  });

  it("shadows no method the client does not have", () => {
    // The `history` fixture has the commit iterator and neither of the other
    // two. Installing an override anyway would turn a moved seam into
    // `github.releaseIterator is not a function`, thrown from inside a
    // generator on first consumption rather than where anyone could read it.
    const source = historySource(history(["a"]).github);
    expect(Object.hasOwn(source, "releaseIterator")).toBe(false);
    expect(Object.hasOwn(source, "tagIterator")).toBe(false);
    expect(Object.hasOwn(source, "getCommitFiles")).toBe(false);
  });
});

/**
 * catalogue is a client whose release and tag walks can be watched: how many
 * times each was started, and which entries upstream actually handed out.
 *
 * What "handed out" measures is the point. A consumer that caps its walk must
 * leave the shared upstream iterator suspended at the cap rather than reading
 * past it, or the cap would cost the pages it was meant to save.
 */
function catalogue(names: string[]): {
  github: GitHubType;
  releaseWalks: number;
  releasesYielded: string[];
  releaseOptions: unknown[];
  tagWalks: number;
  tagsYielded: string[];
} {
  const state = {
    releaseWalks: 0,
    releasesYielded: [] as string[],
    releaseOptions: [] as unknown[],
    tagWalks: 0,
    tagsYielded: [] as string[],
    github: undefined as unknown as GitHubType,
  };
  // Both honour `maxResults` as release-please's own do, which is what makes
  // a walk *started* capped -- the design this file rejects -- observable: the
  // consumer that asked for everything would come back short.
  const capped = (options?: { maxResults?: number }) =>
    names.slice(0, options?.maxResults ?? names.length);

  state.github = {
    // Present only so the source wraps at all: a client with no commit
    // iterator is handed straight back.
    async *mergeCommitIterator(): AsyncGenerator<Commit> {},
    async *releaseIterator(options?: {
      maxResults?: number;
    }): AsyncGenerator<unknown> {
      state.releaseWalks += 1;
      state.releaseOptions.push(options);
      for (const name of capped(options)) {
        state.releasesYielded.push(name);
        yield { id: name, tagName: `v${name}`, sha: name, notes: "" };
      }
    },
    async *tagIterator(options?: {
      maxResults?: number;
    }): AsyncGenerator<unknown> {
      state.tagWalks += 1;
      for (const name of capped(options)) {
        state.tagsYielded.push(name);
        yield { name: `v${name}`, sha: name };
      }
    },
  } as unknown as GitHubType;
  return state as never;
}

/** listReleases drains a release walk, optionally capped as
 * `buildPullRequests` caps it, and optionally stopping early as it does. */
async function listReleases(
  github: GitHubType,
  maxResults?: number,
  stopAfter = Number.POSITIVE_INFINITY,
): Promise<string[]> {
  const out: string[] = [];
  const options = maxResults === undefined ? undefined : { maxResults };
  for await (const release of github.releaseIterator(options)) {
    out.push(release.sha);
    if (out.length >= stopAfter) break;
  }
  return out;
}

/** drain reads a whole walk, naming each item, which is how two walks are
 * compared. */
async function drain<T>(
  walk: AsyncGenerator<T, void, unknown>,
  name: (item: T) => string,
): Promise<string[]> {
  const out: string[] = [];
  for await (const item of walk) out.push(name(item));
  return out;
}

async function listTags(
  github: GitHubType,
  maxResults?: number,
): Promise<string[]> {
  const out: string[] = [];
  const options = maxResults === undefined ? undefined : { maxResults };
  for await (const tag of github.tagIterator(options)) out.push(tag.sha);
  return out;
}

/**
 * Each pass asks for the releases twice -- `Manifest.fromConfig` resolves the
 * last release through `latestReleaseVersion` and `buildPullRequests`
 * resolves it again per component -- so a plain-mode projection listed them
 * four times over its two passes, with identical pages (issue #66).
 */
describe("the cached release walk", () => {
  it("lists the releases once and replays them", async () => {
    const client = catalogue(["a", "b", "c"]);
    const source = historySource(client.github);

    expect(await listReleases(source)).toEqual(["a", "b", "c"]);
    expect(await listReleases(source)).toEqual(["a", "b", "c"]);
    expect(client.releaseWalks).toBe(1);
    expect(client.releasesYielded).toEqual(["a", "b", "c"]);
  });

  it("shares one walk between consumers wanting different amounts", async () => {
    // The two callers do not agree on how many they want: one asks for all of
    // them, the other for the release search depth. Starting the walk capped
    // would leave the uncapped caller short; starting a second walk is the
    // whole cost this avoids. So the cap is applied to what a consumer is
    // handed, not to the walk.
    const client = catalogue(["a", "b", "c", "d"]);
    const source = historySource(client.github);

    expect(await listReleases(source, 2)).toEqual(["a", "b"]);
    // And upstream stopped there, so the cap still saved the pages beyond it.
    expect(client.releasesYielded).toEqual(["a", "b"]);

    // The assertion the design rests on: the client honours `maxResults`, so
    // had the shared walk been started with the first consumer's cap this
    // would come back as `["a", "b"]`.
    expect(await listReleases(source)).toEqual(["a", "b", "c", "d"]);
    expect(client.releaseWalks).toBe(1);
  });

  it("passes on an option it does not know, and keys a walk by it", async () => {
    // The cap is taken out of the question because it is applied at replay.
    // Everything else has to stay in it: an option a release-please upgrade
    // adds decides what the walk yields, and a wrapper that dropped it would
    // both answer a question nobody asked and serve that answer to the caller
    // who did not pass it. Neither says anything on screen.
    const client = catalogue(["a", "b", "c"]);
    const source = historySource(client.github);
    const withOption = { maxResults: 2, includeDrafts: true } as never;

    expect(await listReleases(source)).toEqual(["a", "b", "c"]);
    for await (const _ of source.releaseIterator(withOption)) break;

    expect(client.releaseWalks).toBe(2);
    expect(client.releaseOptions).toEqual([{}, { includeDrafts: true }]);
  });

  it("continues a walk the first consumer stopped short of", async () => {
    // `buildPullRequests` breaks out of its `for await` as soon as it has
    // resolved every component, which calls return() on the generator it is
    // reading. Forwarding that upstream would close the shared walk for good.
    const client = catalogue(["a", "b", "c", "d"]);
    const source = historySource(client.github);

    expect(await listReleases(source, 400, 2)).toEqual(["a", "b"]);
    expect(await listReleases(source)).toEqual(["a", "b", "c", "d"]);
    expect(client.releaseWalks).toBe(1);
  });
});

describe("the cached tag walk", () => {
  it("lists the tags once and replays them", async () => {
    // The fallback when no release resolves a component, reached from both
    // `latestReleaseVersion` and `backfillReleasesFromTags`, and so asked for
    // as many times per projection as the releases are.
    const client = catalogue(["a", "b"]);
    const source = historySource(client.github);

    expect(await listTags(source)).toEqual(["a", "b"]);
    expect(await listTags(source)).toEqual(["a", "b"]);
    expect(client.tagWalks).toBe(1);
    expect(client.tagsYielded).toEqual(["a", "b"]);
  });
});

describe("the commit file lists", () => {
  it("come from the local index when it knows the commit", async () => {
    const client = history(["a"]);
    const source = historySource(client.github, {
      files: (sha) => (sha === "a" ? ["local/a.ts"] : undefined),
    });
    expect(await source.getCommitFiles("a")).toEqual(["local/a.ts"]);
    expect(client.backfilled).toEqual([]);
  });

  it("fall back to the API for a commit it does not", async () => {
    const client = history(["a"]);
    const source = historySource(client.github, { files: () => undefined });
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
): Promise<{ pending: string[]; requests: string[]; graphql: string[] }> {
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
      graphql: [...fake.graphql],
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
 * The caps, measured against release-please's own client rather than against
 * a fake.
 *
 * The wrapper applies `maxResults` to what a consumer is handed instead of to
 * the walk, so it has to read the option exactly as upstream does -- and
 * upstream does not read it the same way twice: `releaseIterator` uses `??`
 * and `tagIterator` uses `||`, so a zero means none of one and all of the
 * other. A fake would only pin this file against itself; the real client is
 * what an upgrade would move.
 */
describe("the caps on the release and tag walks", () => {
  const CAPS = [undefined, 0, 1, 2, 5];

  it("caps its walks exactly as release-please's own do", async () => {
    const fake = await startFakeGitHub({
      owner: "acme",
      repo: "widgets",
      branch: "master",
      files: {},
      commits: [],
      releases: [
        { tagName: "v3.0.0", sha: "a".repeat(40) },
        { tagName: "v2.0.0", sha: "b".repeat(40) },
        { tagName: "v1.0.0", sha: "c".repeat(40) },
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
      const source = historySource(github);

      for (const maxResults of CAPS) {
        const options = maxResults === undefined ? undefined : { maxResults };
        expect([
          maxResults,
          await drain(source.releaseIterator(options), (r) => r.tagName),
        ]).toEqual([
          maxResults,
          await drain(github.releaseIterator(options), (r) => r.tagName),
        ]);
        expect([
          maxResults,
          await drain(source.tagIterator(options), (t) => t.name),
        ]).toEqual([
          maxResults,
          await drain(github.tagIterator(options), (t) => t.name),
        ]);
      }
    } finally {
      await fake.close();
    }
  });
});

/**
 * And the same for the release and tag walks, which is what issue #66 was
 * about. Counting these needs real release-please: how many times it asks is
 * a property of the manifest build, not of anything this action calls.
 */
describe("the release and tag walks a projection makes", () => {
  it("list a manifest repository's releases and commits once", async () => {
    // `buildPullRequests` asks for both once per pass, and there are two
    // passes. Manifest mode asks one commit question rather than plain mode's
    // two, because there is no `fromConfig` and so no `latestReleaseVersion`.
    const seen = await projectOverHttp();
    expect(seen.graphql.filter((query) => query === "releases")).toEqual([
      "releases",
    ]);
    expect(seen.graphql.filter((query) => query === "pullRequestsSince")).toEqual(
      ["pullRequestsSince"],
    );
    // And the tags, which release-please lists even here, where the releases
    // resolve every component: once per pass before this shared them.
    expect(
      seen.requests.filter((r) => r === "GET /repos/acme/widgets/tags"),
    ).toEqual(["GET /repos/acme/widgets/tags"]);
  });

  it("list a plain repository's releases and tags once each", async () => {
    // Plain mode is where it was measured, because `Manifest.fromConfig` asks
    // a second time through `latestReleaseVersion`: four release walks over
    // the two passes before this cached them. With nothing released, both
    // that and `backfillReleasesFromTags` fall through to the tags, so the
    // tag walk is asked for as many times as the release walk is.
    const fake = await startFakeGitHub({
      owner: "acme",
      repo: "widgets",
      branch: "master",
      files: {
        "package.json": JSON.stringify({ name: "widgets", version: "0.0.0" }),
      },
      commits: [],
      releases: [],
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
          files: ["src/a.ts"],
          number: 7,
          headSha: "c".repeat(40),
          headBranch: "topic",
          baseBranch: "master",
        },
      });
      // The projection is still the one the uncached version computed.
      expect(projection.projected.map((r) => r.version)).toEqual(["1.0.0"]);
      expect(fake.graphql.filter((query) => query === "releases")).toEqual([
        "releases",
      ]);
      expect(
        fake.requests.filter((r) => r === "GET /repos/acme/widgets/tags"),
      ).toEqual(["GET /repos/acme/widgets/tags"]);
      // And the commit walks, which is what the caches are keyed for. Plain
      // mode is the mode with two commit questions -- 250 commits with no
      // file lists for `latestReleaseVersion`, the deep backfilling walk for
      // `buildPullRequests` -- so two is the floor, one per question. A
      // single-slot cache is claimed by the first and reads the second afresh
      // in both passes, which is three.
      expect(
        fake.graphql.filter((query) => query === "pullRequestsSince"),
      ).toEqual(["pullRequestsSince", "pullRequestsSince"]);
    } finally {
      await fake.close();
    }
  });
});
