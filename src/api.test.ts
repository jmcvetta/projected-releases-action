import { describe, expect, it } from "vitest";
import { ApiError, Client } from "./api.js";
import type { Fetch } from "./api.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** recorder is a fake fetch that replays canned responses in order and keeps
 * every request, so the assertions can be about the requests as well. */
function recorder(
  responses: { status?: number; body: unknown }[],
): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const next = responses[Math.min(index++, responses.length - 1)] ?? { body: [] };
    const status = next.status ?? 200;
    return {
      ok: status < 400,
      status,
      async text() {
        return typeof next.body === "string" ? next.body : JSON.stringify(next.body);
      },
      headers: { get: () => null },
    };
  };
  return { fetch, calls };
}

const client = (responses: { status?: number; body: unknown }[]) => {
  const { fetch, calls } = recorder(responses);
  return {
    client: new Client({ owner: "acme", repo: "widgets", token: "t", fetch }),
    calls,
  };
};

describe("Client", () => {
  it("authorizes and versions every request", async () => {
    const { client: c, calls } = client([{ body: [] }]);
    await c.openPullRequests();
    expect(calls[0]?.headers["authorization"]).toBe("Bearer t");
    expect(calls[0]?.headers["x-github-api-version"]).toBe("2022-11-28");
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/acme/widgets/pulls?state=open&per_page=100&page=1",
    );
  });

  it("honours a Enterprise Server API root, trailing slash and all", async () => {
    const { fetch, calls } = recorder([{ body: [] }]);
    const c = new Client({
      owner: "acme",
      repo: "widgets",
      token: "t",
      baseUrl: "https://ghe.example/api/v3/",
      fetch,
    });
    await c.openPullRequests();
    expect(calls[0]?.url.startsWith("https://ghe.example/api/v3/repos/")).toBe(true);
  });

  it("carries the status on a failure, so 403 can be told from 500", async () => {
    const { client: c } = client([{ status: 403, body: { message: "no" } }]);
    await expect(c.createComment(1, "x")).rejects.toBeInstanceOf(ApiError);
    await expect(c.createComment(1, "x")).rejects.toMatchObject({ status: 403 });
  });

  it("reads a pull request's head branch and URL", async () => {
    const { client: c } = client([
      { body: [{ html_url: "https://x/1", head: { ref: "release-please--branches--master" } }] },
    ]);
    expect(await c.openPullRequests()).toEqual([
      { headRefName: "release-please--branches--master", url: "https://x/1" },
    ]);
  });

  // release-please leaves one release pull request standing per component
  // until someone merges it, so in a busy repository they are among the
  // oldest open -- which the first page, newest first, does not hold.
  it("follows the pages of open pull requests", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({
      html_url: `https://x/${i}`,
      head: { ref: `topic/${i}` },
    }));
    const { client: c, calls } = client([
      { body: full },
      { body: [{ html_url: "https://x/rp", head: { ref: "release-please--branches--master" } }] },
    ]);
    const prs = await c.openPullRequests();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain("page=2");
    expect(prs).toHaveLength(101);
    expect(prs[100]).toEqual({
      headRefName: "release-please--branches--master",
      url: "https://x/rp",
    });
  });

  // The fallback for a checkout the local diff cannot use. GitHub caps it at
  // 3000 files, which is 30 pages, and a pull request that large is exactly
  // the one where stopping early would misreport the comment's file counts.
  it("reads a pull request's changed files", async () => {
    const { client: c, calls } = client([
      { body: [{ filename: "src/a.ts" }, { filename: "src/b.ts" }] },
    ]);
    expect(await c.pullRequestFiles(7)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/pulls/7/files?per_page=100&page=1");
  });

  it("follows the pages of them", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ filename: `src/${i}.ts` }));
    const { client: c, calls } = client([{ body: full }, { body: [{ filename: "last" }] }]);
    const files = await c.pullRequestFiles(7);
    expect(calls).toHaveLength(2);
    expect(files).toHaveLength(101);
    expect(files[100]).toBe("last");
  });

  it("drops an entry GitHub sent without a filename", async () => {
    const { client: c } = client([{ body: [{}, { filename: "src/a.ts" }] }]);
    expect(await c.pullRequestFiles(7)).toEqual(["src/a.ts"]);
  });

  it("stops paging comments on a short page", async () => {
    const { client: c, calls } = client([{ body: [{ id: 1, body: "hi" }] }]);
    expect(await c.issueComments(7)).toEqual([{ id: 1, body: "hi" }]);
    expect(calls).toHaveLength(1);
  });

  it("defaults a merge setting GitHub did not send to the permissive answer", async () => {
    // The repository payload omits these on some plans; absent must not read
    // as "squash-merge is disabled", which would warn on every pull request.
    const { client: c } = client([{ body: {} }]);
    expect(await c.mergeSettings()).toEqual({
      allowSquash: true,
      allowMerge: true,
      allowRebase: true,
      squashTitle: "PR_TITLE",
      mergeTitle: "MERGE_MESSAGE",
      mergeMessage: "PR_TITLE",
    });
  });

  it("reads the merge settings it was given", async () => {
    const { client: c } = client([
      {
        body: {
          allow_squash_merge: false,
          allow_merge_commit: true,
          allow_rebase_merge: false,
          squash_merge_commit_title: "COMMIT_OR_PR_TITLE",
          merge_commit_title: "PR_TITLE",
          merge_commit_message: "PR_BODY",
        },
      },
    ]);
    expect(await c.mergeSettings()).toEqual({
      allowSquash: false,
      allowMerge: true,
      allowRebase: false,
      squashTitle: "COMMIT_OR_PR_TITLE",
      mergeTitle: "PR_TITLE",
      mergeMessage: "PR_BODY",
    });
  });

  it("reads the branch's commits with one file request each", async () => {
    const { client: c, calls } = client([
      {
        body: [
          { sha: "aaa", commit: { message: "feat: one" } },
          { sha: "bbb", commit: { message: "fix: two" } },
        ],
      },
      { body: { files: [{ filename: "api/one.ts" }] } },
      { body: { files: [{ filename: "ui/two.ts" }] } },
    ]);
    // Newest first, which is the order mergeCommitIterator yields; GitHub
    // lists them oldest first.
    expect(await c.pullRequestCommits(7, 50)).toEqual([
      { sha: "bbb", message: "fix: two", files: ["ui/two.ts"] },
      { sha: "aaa", message: "feat: one", files: ["api/one.ts"] },
    ]);
    expect(calls.map((call) => call.url.replace(/^.*api\.github\.com/, ""))).toEqual([
      "/repos/acme/widgets/pulls/7/commits?per_page=100&page=1",
      "/repos/acme/widgets/commits/aaa",
      "/repos/acme/widgets/commits/bbb",
    ]);
  });

  it("declines a branch longer than the caller will pay for", async () => {
    // One request per commit for the file lists, so the length is the price.
    const { client: c, calls } = client([
      {
        body: [
          { sha: "aaa", commit: { message: "feat: one" } },
          { sha: "bbb", commit: { message: "fix: two" } },
        ],
      },
    ]);
    expect(await c.pullRequestCommits(7, 1)).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("declines a pull request with no commits listed", async () => {
    const { client: c } = client([{ body: [] }]);
    expect(await c.pullRequestCommits(7, 50)).toBeUndefined();
  });

  it("sends a JSON body only when there is one", async () => {
    const { client: c, calls } = client([{ body: { id: 3 } }]);
    await c.updateComment(3, "hello");
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ body: "hello" });
  });
});
