/**
 * api is the small slice of the GitHub REST API this action uses on its own
 * behalf, over `fetch`.
 *
 * release-please brings its own Octokit for the reads that produce the
 * projection. These calls are the ones it does not make: finding the standing
 * release pull requests, reading the repository's merge settings, and posting
 * the comment. Doing them by hand keeps the bundle to release-please and its
 * dependencies rather than adding a second client beside the one already in
 * there, and each call is a URL and a shape rather than a wrapper to learn.
 */

import type { BranchCommit } from "./pr-view.js";

/** GITHUB_API is the REST root, overridable for GitHub Enterprise Server. */
export const GITHUB_API = "https://api.github.com";

/** Fetch is the subset of `fetch` this module needs. Injected for tests. */
export type Fetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
}>;

/** ClientOptions are what a client needs to reach one repository. */
export interface ClientOptions {
  owner: string;
  repo: string;
  token: string;
  /** baseUrl is the REST root. Defaults to github.com's. */
  baseUrl?: string;
  fetch?: Fetch;
}

/** ApiError carries the status and body of a failed request, because a 403
 * on a fork pull request needs to read differently from a 500. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** IssueComment is one comment on a pull request. */
export interface IssueComment {
  id: number;
  body: string;
}

/** OpenPullRequest is one open pull request, as release-pr discovery reads it. */
export interface OpenPullRequest {
  headRefName: string;
  url: string;
}

/**
 * RepositoryMergeSettings is what the repository does with a merge button.
 *
 * `squashTitle` is GitHub's `squash_merge_commit_title`: `PR_TITLE` always
 * uses the pull request title as the squashed subject, while
 * `COMMIT_OR_PR_TITLE` uses the branch's single commit's subject when there
 * is exactly one commit, and the pull request title otherwise.
 *
 * `mergeTitle` and `mergeMessage` are the same two settings for the merge
 * commit a merge-commit merge writes above the branch's own commits:
 * `merge_commit_title` is `MERGE_MESSAGE` (GitHub's "Merge pull request #N
 * from …") or `PR_TITLE`, and `merge_commit_message` is `PR_TITLE`,
 * `PR_BODY` or `BLANK`. They decide whether that commit carries a
 * Conventional Commit at all, which is not a detail: see
 * `mergeCommitMessage` in merge-method.ts.
 */
export interface RepositoryMergeSettings {
  allowSquash: boolean;
  allowMerge: boolean;
  allowRebase: boolean;
  squashTitle: string;
  mergeTitle: string;
  mergeMessage: string;
}

/** Client talks to one repository. */
export class Client {
  private readonly owner: string;
  private readonly repo: string;
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly doFetch: Fetch;

  constructor(options: ClientOptions) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? GITHUB_API).replace(/\/+$/, "");
    this.doFetch = options.fetch ?? (globalThis.fetch as unknown as Fetch);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "projected-releases",
      authorization: `Bearer ${this.token}`,
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    const response = await this.doFetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new ApiError(
        response.status,
        `${method} ${path} failed: ${response.status} ${text.slice(0, 400)}`,
      );
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private repoPath(suffix: string): string {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(
      this.repo,
    )}${suffix}`;
  }

  /**
   * mergeSettings reads what the repository will do with the merge button.
   *
   * The projection models a squash-merge, because that is the only merge
   * method under which a pull request contributes exactly one Conventional
   * Commit. A repository that does something else gets a warning rather than
   * a wrong answer.
   */
  async mergeSettings(): Promise<RepositoryMergeSettings> {
    const raw = await this.request<Record<string, unknown>>(
      "GET",
      this.repoPath(""),
    );
    return {
      allowSquash: raw["allow_squash_merge"] !== false,
      allowMerge: raw["allow_merge_commit"] !== false,
      allowRebase: raw["allow_rebase_merge"] !== false,
      squashTitle: String(raw["squash_merge_commit_title"] ?? "PR_TITLE"),
      // GitHub's own defaults for a repository that has never been told
      // otherwise, which the REST response omits rather than spells.
      mergeTitle: String(raw["merge_commit_title"] ?? "MERGE_MESSAGE"),
      mergeMessage: String(raw["merge_commit_message"] ?? "PR_TITLE"),
    };
  }

  /**
   * pullRequestCommits lists the commits on the pull request's branch, newest
   * first, each with the files it changes.
   *
   * The fallback for a checkout `branchCommits` cannot read, and it is
   * expensive in a way the rest of this file is not: GitHub has no per-commit
   * files endpoint for a pull request, so the file lists cost one request per
   * commit. `limit` is what keeps that from being paid quietly — over it, the
   * answer is undefined and the caller says it could not model the merge
   * rather than spending two hundred requests to.
   *
   * Newest first because that is the order `mergeCommitIterator` yields and
   * the order the projection wants; GitHub lists them oldest first.
   */
  async pullRequestCommits(
    number: number,
    limit: number,
  ): Promise<BranchCommit[] | undefined> {
    const listed: { sha: string; message: string }[] = [];
    // GitHub caps this endpoint at 250 commits, so three pages is all there
    // is; a branch longer than that is past `limit` regardless.
    for (let page = 1; page <= 3; page++) {
      const batch = await this.request<
        { sha?: string; commit?: { message?: string } }[]
      >("GET", this.repoPath(`/pulls/${number}/commits?per_page=100&page=${page}`));
      for (const commit of batch) {
        if (commit.sha) {
          listed.push({ sha: commit.sha, message: commit.commit?.message ?? "" });
        }
      }
      // Checked per page rather than at the end: a branch past the cap is
      // declined whatever the rest of it holds, and the pages after the one
      // that passed it are requests spent on an answer already given up on.
      if (listed.length > limit) return undefined;
      if (batch.length < 100) break;
    }
    if (listed.length === 0) return undefined;

    const commits: BranchCommit[] = [];
    for (const commit of listed) {
      commits.push({ ...commit, files: await this.commitFiles(commit.sha) });
    }
    return commits.reverse();
  }

  /**
   * commitFiles lists what one commit changes, which for a merge commit is
   * its diff against the first parent — the same diff `git log
   * --diff-merges=first-parent` reports.
   */
  async commitFiles(sha: string): Promise<string[]> {
    const raw = await this.request<{ files?: { filename?: string }[] }>(
      "GET",
      this.repoPath(`/commits/${encodeURIComponent(sha)}`),
    );
    return (raw.files ?? []).flatMap((file) =>
      file.filename ? [file.filename] : [],
    );
  }

  /**
   * openPullRequests lists every open pull request, following pages.
   *
   * The release pull requests it is read for are among the oldest a busy
   * repository has open — release-please leaves one standing per component
   * until someone merges it — so a single page of 100, newest first, is
   * exactly where they are not. Stopping there lost the links in the
   * repositories most likely to want them.
   */
  async openPullRequests(): Promise<OpenPullRequest[]> {
    const prs: OpenPullRequest[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.request<
        { html_url?: string; head?: { ref?: string } }[]
      >("GET", this.repoPath(`/pulls?state=open&per_page=100&page=${page}`));
      for (const pr of batch) {
        prs.push({ headRefName: pr.head?.ref ?? "", url: pr.html_url ?? "" });
      }
      if (batch.length < 100) break;
    }
    return prs;
  }

  /**
   * pullRequestFiles lists the files a pull request changes.
   *
   * The fallback for a checkout the local diff cannot use — a shallow one has
   * neither the merge base nor the branch. GitHub caps this at 3000 files,
   * which is a real limit: past it the comment's **Files** counts are
   * incomplete. It is only ever a fallback for that reason.
   */
  async pullRequestFiles(number: number): Promise<string[]> {
    const files: string[] = [];
    for (let page = 1; page <= 30; page++) {
      const batch = await this.request<{ filename?: string }[]>(
        "GET",
        this.repoPath(`/pulls/${number}/files?per_page=100&page=${page}`),
      );
      for (const file of batch) if (file.filename) files.push(file.filename);
      if (batch.length < 100) break;
    }
    return files;
  }

  /** issueComments lists every comment on a pull request, following pages. */
  async issueComments(number: number): Promise<IssueComment[]> {
    const comments: IssueComment[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.request<{ id: number; body?: string }[]>(
        "GET",
        this.repoPath(`/issues/${number}/comments?per_page=100&page=${page}`),
      );
      comments.push(...batch.map((c) => ({ id: c.id, body: c.body ?? "" })));
      if (batch.length < 100) break;
    }
    return comments;
  }

  /** createComment posts a new comment on a pull request. */
  async createComment(number: number, body: string): Promise<IssueComment> {
    return this.request<IssueComment>(
      "POST",
      this.repoPath(`/issues/${number}/comments`),
      { body },
    );
  }

  /** updateComment rewrites an existing comment in place. */
  async updateComment(id: number, body: string): Promise<IssueComment> {
    return this.request<IssueComment>(
      "PATCH",
      this.repoPath(`/issues/comments/${id}`),
      { body },
    );
  }
}
