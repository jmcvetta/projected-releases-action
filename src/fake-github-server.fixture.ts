/**
 * fake-github-server serves just enough of the GitHub API, over real HTTP, to
 * drive one projection end to end.
 *
 * The other fixture, fake-scm, substitutes a `GitHub` object and so skips
 * everything between this action's options and release-please's HTTP calls:
 * URL assembly, the Octokit clients, and the whole bundled artifact. Two bugs
 * lived in exactly that gap and neither was reachable from a unit test -- a
 * GraphQL URL built as `.../graphql/graphql`, and a changelog preset reading
 * template files that the bundle did not ship.
 *
 * So this fake is deliberately literal about URLs. It serves GraphQL at
 * `/graphql` and nothing else, which is what makes a wrongly-assembled
 * endpoint a 404 here exactly as it is against github.com.
 *
 * It serves two families of endpoint, and the distinction is worth keeping in
 * mind when adding to it. release-please reads the git trees, blobs, tags and
 * GraphQL history; the action reads the repository's merge settings and its
 * open pull requests, lists a pull request's files, and posts its own comment.
 * Only the first family is needed to render a projection -- but an entry point
 * makes both, and the decisions worth testing in src/action.ts are about what
 * it does when one of the second family fails.
 */

import { createServer } from "node:http";
import type { Server } from "node:http";
import { AddressInfo } from "node:net";

/** FakeRepo is the repository state the fake serves. */
export interface FakeRepo {
  owner: string;
  repo: string;
  branch: string;
  /** files are served through the git tree and blob endpoints, which is how
   * release-please reads a package.json. */
  files: Record<string, string>;
  /**
   * commits are the merge commits on the branch, newest first.
   *
   * `unassociated` drops the pull request GitHub would associate with the
   * commit, which is what a direct push to the branch looks like. It is the
   * case that costs a REST round trip per commit: with no pull request to
   * take a file list from, release-please backfills one commit at a time.
   */
  commits: {
    sha: string;
    message: string;
    files: string[];
    unassociated?: boolean;
  }[];
  /** releases are the published releases, newest first. */
  releases: { tagName: string; sha: string }[];
  /** pullRequests are the open pull requests the REST list endpoint serves,
   * which is where the action finds the standing release pull requests. */
  pullRequests?: { headRefName: string; url: string }[];
  /** prFiles is the changed-file list per pull request number, served by the
   * REST endpoint the action falls back to when the checkout cannot be
   * diffed. Absent means the pull request has none. */
  prFiles?: Record<number, string[]>;
  /**
   * prCommits are the commits on a pull request's branch, oldest first as
   * GitHub lists them. They are what a merge or a rebase puts on the target
   * branch, and the action reads them here when the checkout is too shallow
   * to hold them -- one further request each for their files, which is why
   * the fake serves those from the same list.
   */
  prCommits?: Record<number, { sha: string; message: string; files: string[] }[]>;
  /**
   * merge overrides the repository's merge-button settings, which decide
   * which merge the projection models. The default is a squash-merging
   * repository.
   */
  merge?: Record<string, unknown>;
  /** commentStatus forces a status on the comment write endpoints. 403 and
   * 404 are what a fork's read-only token gets and are meant to cost the
   * comment rather than the run; anything else is a real failure. */
  commentStatus?: number;
  /** pullsStatus forces a status on the open pull request list, whose failure
   * is meant to cost the release pull request links and nothing else. */
  pullsStatus?: number;
  /** repositoryStatus forces a status on the repository endpoint the merge
   * settings are read from, whose failure is meant to cost the merge
   * advisory and nothing else. */
  repositoryStatus?: number;
}

/** FakeGitHub is a running fake, and the record of what was asked of it. */
export interface FakeGitHub {
  /** url is the API root to hand the action as both api-url and graphql-url. */
  url: string;
  /** requests are every path requested, in order. */
  requests: string[];
  /**
   * graphql names every GraphQL query asked of the fake, in order:
   * `releases`, or `history` for either of the commit-walking queries.
   *
   * `requests` cannot tell them apart -- every one of them is a POST to the
   * one `/graphql` path -- and how many times a projection lists the
   * repository's releases is exactly what issue #66 was about.
   */
  graphql: string[];
  /** comments are the issue comments as the fake now holds them, so a test
   * can assert what was posted rather than only that a post happened. */
  comments: { id: number; body: string }[];
  close(): Promise<void>;
}

const BLOB = (path: string) => `blob-${Buffer.from(path).toString("hex")}`;

/** startFakeGitHub serves `repo` until closed. */
export async function startFakeGitHub(repo: FakeRepo): Promise<FakeGitHub> {
  const requests: string[] = [];
  const graphql: string[] = [];
  const comments: { id: number; body: string }[] = [];
  let nextCommentId = 100;

  const commitNodes = repo.commits.map((commit) => ({
    associatedPullRequests: {
      nodes: commit.unassociated ? [] : [
        {
          number: 1,
          title: commit.message.split("\n")[0],
          baseRefName: repo.branch,
          headRefName: "topic",
          labels: { nodes: [] },
          body: "",
          mergeCommit: { oid: commit.sha },
          files: {
            nodes: commit.files.map((path) => ({ path })),
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      ],
    },
    sha: commit.sha,
    message: commit.message,
    author: { name: "A", email: "a@b.c", user: { login: "a" } },
  }));

  const base = `/repos/${repo.owner}/${repo.repo}`;
  // The action's own REST calls, matched on the path alone because every one
  // of them carries pagination in the query string.
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const FILES = new RegExp(`^${escaped}/pulls/(\\d+)/files$`);
  const PR_COMMITS = new RegExp(`^${escaped}/pulls/(\\d+)/commits$`);
  const COMMENTS = new RegExp(`^${escaped}/issues/\\d+/comments$`);
  const COMMENT = new RegExp(`^${escaped}/issues/comments/(\\d+)$`);
  const COMMIT_FILES = new RegExp(`^${escaped}/commits/([0-9a-z]+)$`);

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = req.url ?? "";
      requests.push(`${req.method} ${url.split("?")[0]}`);
      const send = (code: number, payload: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      // GraphQL, at exactly one path. An endpoint assembled as
      // `/graphql/graphql` falls through to the 404 below, which is the whole
      // point of serving this over real HTTP.
      if (url === "/graphql") {
        const query = String(JSON.parse(body || "{}").query ?? "");
        const releases = query.includes("query releases");
        graphql.push(releases ? "releases" : "history");
        if (releases) {
          return send(200, {
            data: {
              repository: {
                releases: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: repo.releases.map((release) => ({
                    name: release.tagName,
                    tagName: release.tagName,
                    url: "",
                    description: "",
                    isDraft: false,
                    databaseId: 1,
                    tagCommit: { oid: release.sha },
                  })),
                },
              },
            },
          });
        }
        // Both commit-walking queries share a shape.
        return send(200, {
          data: {
            repository: {
              ref: {
                target: {
                  history: {
                    nodes: commitNodes,
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          },
        });
      }

      const path = url.split("?")[0] ?? "";
      if (path === `${base}/pulls`) {
        if (repo.pullsStatus) return send(repo.pullsStatus, { message: "no" });
        return send(
          200,
          (repo.pullRequests ?? []).map((pr) => ({
            html_url: pr.url,
            head: { ref: pr.headRefName },
          })),
        );
      }
      const files = FILES.exec(path);
      if (files) {
        return send(
          200,
          (repo.prFiles?.[Number(files[1])] ?? []).map((filename) => ({
            filename,
          })),
        );
      }
      const prCommits = PR_COMMITS.exec(path);
      if (prCommits) {
        // Paged as GitHub pages it, because how many pages the action asks
        // for is part of what it costs a repository: a caller that has
        // already decided a branch is too long to model must stop asking.
        const query = new URLSearchParams(url.split("?")[1] ?? "");
        const perPage = Number(query.get("per_page") ?? "30");
        const page = Number(query.get("page") ?? "1");
        const all = repo.prCommits?.[Number(prCommits[1])] ?? [];
        return send(
          200,
          all.slice((page - 1) * perPage, page * perPage).map((commit) => ({
            sha: commit.sha,
            commit: { message: commit.message },
          })),
        );
      }
      if (COMMENTS.test(path)) {
        if (req.method === "GET") return send(200, comments);
        if (repo.commentStatus) {
          return send(repo.commentStatus, { message: "no" });
        }
        const created = {
          id: nextCommentId++,
          body: String(JSON.parse(body || "{}").body ?? ""),
        };
        comments.push(created);
        return send(201, created);
      }
      const edit = COMMENT.exec(path);
      if (edit) {
        if (repo.commentStatus) {
          return send(repo.commentStatus, { message: "no" });
        }
        const existing = comments.find((c) => c.id === Number(edit[1]));
        if (!existing) return send(404, { message: "no comment" });
        existing.body = String(JSON.parse(body || "{}").body ?? "");
        return send(200, existing);
      }

      const commit = COMMIT_FILES.exec(path);
      if (commit) {
        // What release-please backfills a file list with when GraphQL gave it
        // no pull request to read one from.
        const found =
          repo.commits.find((c) => c.sha === commit[1]) ??
          Object.values(repo.prCommits ?? {})
            .flat()
            .find((c) => c.sha === commit[1]);
        if (!found) return send(404, { message: "no commit" });
        return send(200, {
          sha: found.sha,
          files: found.files.map((filename) => ({ filename })),
        });
      }

      if (url.startsWith(`${base}/git/trees/`)) {
        return send(200, {
          sha: "tree",
          truncated: false,
          tree: Object.keys(repo.files).map((path) => ({
            path,
            mode: "100644",
            type: "blob",
            sha: BLOB(path),
            size: repo.files[path]!.length,
          })),
        });
      }
      if (url.startsWith(`${base}/git/blobs/`)) {
        const sha = url.split("/").pop() ?? "";
        const path = Object.keys(repo.files).find((p) => BLOB(p) === sha);
        if (path === undefined) return send(404, { message: "no blob" });
        return send(200, {
          sha,
          encoding: "base64",
          content: Buffer.from(repo.files[path]!, "utf8").toString("base64"),
        });
      }
      if (url.startsWith(`${base}/tags`)) {
        // release-please falls back to tags when the release list does not
        // resolve a version, so a fake that omits them changes the answer.
        return send(
          200,
          repo.releases.map((release) => ({
            name: release.tagName,
            commit: { sha: release.sha },
          })),
        );
      }
      if (url === base) {
        if (repo.repositoryStatus) {
          return send(repo.repositoryStatus, { message: "no" });
        }
        return send(200, {
          default_branch: repo.branch,
          allow_squash_merge: true,
          squash_merge_commit_title: "PR_TITLE",
          ...repo.merge,
        });
      }
      return send(404, { message: `fake has no ${url}` });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    graphql,
    comments,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
