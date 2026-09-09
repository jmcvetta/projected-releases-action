import { beforeAll, describe, expect, it } from "vitest";
import { GitHub, setLogger } from "release-please";
import type { GitHub as GitHubType } from "release-please";
import {
  RETRIES,
  TRANSIENT_MESSAGE,
  retryingGraphql,
  transientGraphqlError,
} from "./graphql-retry.js";
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

/** graphqlError builds what Octokit raises for a 200 carrying an `errors`
 * array: an error with no `status`, which is why release-please's own loop
 * drops it. */
function graphqlError(...errors: unknown[]): Error {
  return Object.assign(new Error("Request failed"), { errors });
}

/** transient is GitHub's own wording for a failure on its side. */
function transient(): Error {
  return graphqlError({
    message: `${TRANSIENT_MESSAGE} on 2026-09-09T14:35:34Z. Please include \`7019\`.`,
  });
}

/** client is a stand-in release-please client whose GraphQL call answers the
 * given script, one entry per attempt, and records what it was asked for. */
function client(script: unknown[]): {
  github: GitHubType;
  pages: (number | undefined)[];
} {
  const pages: (number | undefined)[] = [];
  let attempt = 0;
  const github = {
    graphqlRequest(opts: Record<string, unknown>): Promise<unknown> {
      pages.push(typeof opts.num === "number" ? opts.num : undefined);
      const answer = script[attempt++];
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer);
    },
  } as unknown as GitHubType;
  return { github, pages };
}

/** ask calls the wrapped client's GraphQL entry point, which release-please
 * declares private and reaches through `this`. */
function ask(
  github: GitHubType,
  opts: Record<string, unknown>,
): Promise<unknown> {
  const holder = github as unknown as {
    graphqlRequest: (opts: Record<string, unknown>) => Promise<unknown>;
  };
  return holder.graphqlRequest(opts);
}

describe("which failures are asked again", () => {
  it("reads GitHub's own wording for a failure on its side", () => {
    expect(transientGraphqlError(transient())).toBe(true);
    expect(
      transientGraphqlError(graphqlError({ type: "SERVICE_UNAVAILABLE" })),
    ).toBe(true);
  });

  it("leaves an answer that will not change", () => {
    // Retrying these buys nothing, and RATE_LIMITED costs: the attempts spend
    // what budget is left and defer the error that says what happened.
    for (const type of ["NOT_FOUND", "FORBIDDEN", "RATE_LIMITED"]) {
      expect(transientGraphqlError(graphqlError({ type }))).toBe(false);
    }
    // A typed error is judged by its type, whatever its message reads like.
    expect(
      transientGraphqlError(
        graphqlError({ type: "FORBIDDEN", message: TRANSIENT_MESSAGE }),
      ),
    ).toBe(false);
  });

  it("needs every error in the response to be transient", () => {
    // Half of the report says what to fix, and it will say the same next time.
    expect(
      transientGraphqlError(
        graphqlError({ message: TRANSIENT_MESSAGE }, { type: "FORBIDDEN" }),
      ),
    ).toBe(false);
  });

  it("is not anything else that was thrown", () => {
    expect(transientGraphqlError(new Error("socket hang up"))).toBe(false);
    expect(transientGraphqlError(graphqlError())).toBe(false);
    expect(transientGraphqlError(undefined)).toBe(false);
    expect(transientGraphqlError(null)).toBe(false);
  });
});

describe("the retry", () => {
  const nap = { sleep: async () => {}, log: () => {} };

  it("asks again and answers with what arrived", async () => {
    const stub = client([transient(), transient(), { ok: true }]);
    const source = retryingGraphql(stub.github, nap);

    expect(await ask(source, { num: 100 })).toEqual({ ok: true });
    expect(stub.pages).toHaveLength(3);
  });

  it("halves the page each time, and asks for one on the last attempt", async () => {
    // The page is why the query was too much work to finish. Halving is
    // release-please's own answer to the 502 it does retry, and the cursor is
    // per page, so a smaller page changes nothing about what the walk yields.
    const stub = client([
      transient(),
      transient(),
      transient(),
      transient(),
      transient(),
      { ok: true },
    ]);
    const source = retryingGraphql(stub.github, { ...nap, retries: 5 });

    await ask(source, { num: 100 });
    expect(stub.pages).toEqual([100, 50, 25, 12, 6, 1]);
  });

  it("keeps the page that worked, for every later request", async () => {
    // A walk is many requests. A size GitHub could not finish says something
    // about the query rather than about the page it failed on, so climbing
    // back to it would pay a failure and a backoff on every page.
    const stub = client([transient(), { ok: 1 }, { ok: 2 }, { ok: 3 }]);
    const source = retryingGraphql(stub.github, nap);

    await ask(source, { num: 100 });
    await ask(source, { num: 100 });
    await ask(source, { num: 100 });
    expect(stub.pages).toEqual([100, 50, 50, 50]);
  });

  it("lowers that page only to a size that was served", async () => {
    // The last size tried is not the one that worked: a request that ran out
    // of halvings and succeeded at one commit is the only thing that makes a
    // page of one the ceiling.
    const stub = client([transient(), transient(), { ok: 1 }, { ok: 2 }]);
    const source = retryingGraphql(stub.github, { ...nap, retries: 2 });

    await ask(source, { num: 100 });
    await ask(source, { num: 100 });
    expect(stub.pages).toEqual([100, 50, 1, 1]);
  });

  it("keeps a page per query, not per client", async () => {
    // Two queries asking for the same number of nodes are not asking for the
    // same work, so one settling at a smaller page says nothing about the
    // other.
    const stub = client([transient(), { ok: 1 }, { ok: 2 }]);
    const source = retryingGraphql(stub.github, nap);

    await ask(source, { query: "query pullRequestsSince", num: 100 });
    await ask(source, { query: "query mergedPullRequests", num: 100 });
    expect(stub.pages).toEqual([100, 50, 100]);
  });

  it("leaves a request that names no page alone", async () => {
    // `num` is the commit walk's variable; the release and tag walks carry no
    // page size for a retry to shrink.
    const stub = client([transient(), { ok: true }]);
    const source = retryingGraphql(stub.github, nap);

    await ask(source, { cursor: null });
    expect(stub.pages).toEqual([undefined, undefined]);
  });

  it("throws when the attempts run out", async () => {
    // The alternative -- release-please's own loop, which gives up by
    // returning undefined -- reaches `mergeCommitIterator` as "the branch does
    // not exist" and breaks. A walk that ran out of retries would then be a
    // short history rather than an error.
    const last = transient();
    const stub = client([transient(), transient(), last]);
    const source = retryingGraphql(stub.github, { ...nap, retries: 2 });

    await expect(ask(source, { num: 100 })).rejects.toBe(last);
    expect(stub.pages).toEqual([100, 50, 1]);
  });

  it("throws an error it will not ask again about, on the first attempt", async () => {
    const refused = graphqlError({ type: "FORBIDDEN" });
    const stub = client([refused, { ok: true }]);
    const source = retryingGraphql(stub.github, nap);

    await expect(ask(source, { num: 100 })).rejects.toBe(refused);
    expect(stub.pages).toEqual([100]);
  });

  it("backs off, doubling and capped", async () => {
    const slept: number[] = [];
    const stub = client([
      transient(),
      transient(),
      transient(),
      transient(),
      transient(),
      transient(),
      { ok: true },
    ]);
    const source = retryingGraphql(stub.github, {
      log: () => {},
      retries: 6,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    await ask(source, {});
    expect(slept).toEqual([1000, 2000, 4000, 8000, 16000, 20000]);
  });

  it("throws when release-please's own loop gives up", async () => {
    // It gives up by returning nothing, and `mergeCommitIterator` reads a
    // missing response as a branch that does not exist and stops. Reported as
    // a value, that is a walk which ends early and looks finished.
    const stub = client([undefined]);
    const source = retryingGraphql(stub.github, nap);

    await expect(ask(source, { num: 100 })).rejects.toThrow(/ran out of retries/);
  });

  it("hands back a client with no GraphQL call untouched", () => {
    // Nothing is shadowed that is not there to shadow. The seam moving is what
    // the tests over real release-please below are for.
    const bare = {} as unknown as GitHubType;
    expect(retryingGraphql(bare)).toBe(bare);
  });

  it("retries five times by default, as release-please does its own 502", () => {
    expect(RETRIES).toBe(5);
  });
});

/**
 * The seam, driven through real release-please over the fake server.
 *
 * The override is only ever reached because release-please calls
 * `this.graphql` from inside its own request loop. Nothing about that is
 * checked by a stub, and its failure is silence: the requests still go out,
 * the answer is still right when GitHub is well, and the retry simply never
 * happens. So the client here is a real one and the failure is a real HTTP
 * 200 carrying an `errors` array.
 */
const REPO = {
  owner: "acme",
  repo: "widgets",
  branch: "master",
  files: { "package.json": JSON.stringify({ name: "widgets" }) },
  commits: [{ sha: "feed01", message: "feat: a thing", files: ["src/x.ts"] }],
  releases: [],
};

describe("a failing page, over HTTP", () => {
  it("is asked again, smaller, and the walk completes", async () => {
    const fake = await startFakeGitHub({
      ...REPO,
      graphqlFailures: { pullRequestsSince: 2 },
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
      const source = retryingGraphql(github, {
        sleep: async () => {},
        log: () => {},
      });

      const out: string[] = [];
      for await (const commit of source.mergeCommitIterator("master", {
        batchSize: 100,
      })) {
        out.push(commit.sha);
      }

      expect(out).toEqual(["feed01"]);
      expect(fake.graphql).toEqual([
        "pullRequestsSince",
        "pullRequestsSince",
        "pullRequestsSince",
      ]);
      expect(fake.graphqlPages).toEqual([100, 50, 25]);
    } finally {
      await fake.close();
    }
  });

  it("still throws once the attempts run out, rather than reading short", async () => {
    // This is the whole reason the retries are not left to release-please's
    // own loop: that one gives up by returning undefined, which
    // `mergeCommitIterator` reads as a branch that does not exist and breaks
    // on. The walk would end with no commits, no error, and a version computed
    // over the wrong span.
    const fake = await startFakeGitHub({
      ...REPO,
      graphqlFailures: { pullRequestsSince: 99 },
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
      const source = retryingGraphql(github, {
        retries: 2,
        sleep: async () => {},
        log: () => {},
      });

      const walk = async (): Promise<string[]> => {
        const out: string[] = [];
        for await (const commit of source.mergeCommitIterator("master", {
          batchSize: 100,
        })) {
          out.push(commit.sha);
        }
        return out;
      };

      await expect(walk()).rejects.toThrow();
    } finally {
      await fake.close();
    }
  });
});

describe("a projection whose first page fails", () => {
  it("is rendered anyway", async () => {
    // The composition order in project.ts is what this holds: the retry wraps
    // the client and `historySource` wraps the result. Inverted, the iterator
    // is started with the history wrapper as its receiver, the override is
    // never reached, and this test sees the failure the action used to fail
    // on.
    const fake = await startFakeGitHub({
      ...REPO,
      files: {
        "release-please-config.json": JSON.stringify({
          packages: { ".": { "release-type": "node" } },
        }),
        ".release-please-manifest.json": JSON.stringify({ ".": "1.0.0" }),
        "package.json": JSON.stringify({ name: "widgets", version: "1.0.0" }),
      },
      graphqlFailures: { pullRequestsSince: 1 },
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
        config: { packages: { ".": { "release-type": "node" } } },
        manifest: { ".": "1.0.0" },
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

      expect(projection.projected.map((one: { version: string }) => one.version)).toEqual(
        ["1.1.0"],
      );
      // The pages of the commit walk alone: release-please asks other
      // queries in between, and they carry pages of their own.
      const walked = fake.graphqlPages.filter(
        (_page, at) => fake.graphql[at] === "pullRequestsSince",
      );
      expect(walked.slice(0, 2)).toEqual([100, 50]);
    } finally {
      await fake.close();
    }
  }, 20000);
});
