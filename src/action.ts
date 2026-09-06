/**
 * action is the GitHub Actions entry point.
 *
 * Everything it needs about the pull request it takes from the webhook
 * payload, so the ordinary workflow is `uses:` and nothing else. Every one of
 * those values is also an input, because the fork-safe arrangement runs this
 * from a `workflow_run` job where there is no pull request payload at all.
 *
 * It renders and, by default, posts. The two are separable (`mode`) for that
 * same fork-safe arrangement: the pull request job renders with a read-only
 * token, and a second job with a write token posts what it rendered.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { Client, ApiError } from "./api.js";
import type { RepositoryMergeSettings } from "./api.js";
import { DEFAULT_HEADER, stick } from "./comment.js";
import { branchCommits, changedFiles } from "./git.js";
import {
  isMergeMethod,
  mergeAdvisories,
  mergeCommitFor,
  MERGE_METHODS,
  projectedMethod,
} from "./merge-method.js";
import type { MergeMethod, ProjectedMethod } from "./merge-method.js";
import { plainConfig } from "./plain.js";
import type { BranchCommit } from "./pr-view.js";
import {
  COMMIT_SEARCH_DEPTH,
  DEFAULT_CONFIG_FILE,
  DEFAULT_MANIFEST_FILE,
} from "./project.js";
import { indexReleasePrs } from "./release-prs.js";
import { buildComment, quietLogger } from "./run.js";
import {
  boolInput,
  input,
  inputOr,
  listInput,
  notice,
  readEvent,
  setOutput,
  summary,
  warning,
} from "./runner.js";
import type { Env } from "./runner.js";
import { AUTO } from "./workflow.js";

/** Mode is what one invocation does. */
export type Mode = "render-and-comment" | "render" | "comment";

const MODES: readonly Mode[] = ["render-and-comment", "render", "comment"];

/** DEFAULT_OUTPUT is where the rendered body is written. */
const DEFAULT_OUTPUT = "projected-releases.md";

/**
 * action renders and posts the projection for the pull request the runner is
 * running against. Exported rather than run on import, so the bundled entry
 * point can dispatch to it and the tests can drive it against a fake
 * environment.
 */
export async function action(env: Env = process.env): Promise<void> {
  const mode = inputOr("mode", "render-and-comment", env) as Mode;
  if (!MODES.includes(mode)) {
    throw new Error(`input \`mode\` must be one of ${MODES.join(", ")}`);
  }

  const event = readEvent(env);
  const repository = inputOr("repository", env["GITHUB_REPOSITORY"] ?? "", env);
  if (!repository.includes("/")) {
    throw new Error("could not determine the repository; set `repository`");
  }
  const [owner = "", repo = ""] = repository.split("/");

  const number = Number(inputOr("number", String(event.number ?? 0), env));
  if (!number) {
    throw new Error("could not determine the pull request number; set `number`");
  }

  const token = input("token", env);
  if (!token) throw new Error("input `token` is required");

  const apiUrl = inputOr("api-url", env["GITHUB_API_URL"] ?? "", env);
  const client = new Client({
    owner,
    repo,
    token,
    ...(apiUrl ? { baseUrl: apiUrl } : {}),
  });
  const graphqlUrl = inputOr("graphql-url", env["GITHUB_GRAPHQL_URL"] ?? "", env);
  const header = inputOr("comment-header", DEFAULT_HEADER, env);
  const outputFile = inputOr("output-file", DEFAULT_OUTPUT, env);

  // `comment` mode posts a body rendered by an earlier job and does nothing
  // else. It exists for the fork-safe arrangement, where rendering happens
  // with a read-only token and posting happens in a separate workflow.
  if (mode === "comment") {
    await post(client, number, header, readFileSync(outputFile, "utf8"));
    setOutput("comment-file", outputFile, env);
    return;
  }

  const title = inputOr("title", event.title ?? "", env);
  if (!title) throw new Error("could not determine the title; set `title`");
  const body = input("body", env) || event.body || "";
  const base = inputOr("base", event.base ?? env["GITHUB_BASE_REF"] ?? "", env);
  if (!base) throw new Error("could not determine the base branch; set `base`");
  const headSha = inputOr("head-sha", event.headSha ?? "", env);
  const headBranch = inputOr("head-branch", event.headBranch ?? "", env);

  quietLogger();

  const plain = plainConfig((name) => input(name, env), (name) => `input \`${name}\``);
  const merge = await mergePlan(client, env);
  const releasePrs = await standingReleasePrs(client, env, base);
  const files = await pullRequestFiles(client, number, base, env);

  // What merging actually writes, where it is not one squashed commit. The
  // pull request facts are the same ones the squash commit is built from; the
  // difference is that they no longer describe a commit message.
  const branch =
    merge.method === "squash"
      ? undefined
      : await branchInput(client, env, merge.method, {
          number,
          base,
          files,
          settings: merge.settings,
          pr: {
            number,
            title,
            body,
            headLabel: `${owner}/${headBranch || "HEAD"}`,
            headSha: headSha || "0".repeat(40),
          },
        });

  const advisories = mergeAdvisories({
    method: merge.declared,
    ...(merge.settings ? { settings: merge.settings } : {}),
    commits: event.commits,
    modelled: branch ? merge.method : "squash",
  });

  const outcome = await buildComment({
    owner,
    repo,
    token,
    title,
    body,
    number,
    base,
    headSha,
    headBranch,
    files,
    ...(branch ? { branch } : {}),
    repoRoot: inputOr("repo-root", ".", env),
    // The same ref the changed-file diff runs against, so one input decides
    // where both local reads look.
    baseRef: inputOr("diff-base", `origin/${base}`, env),
    ...(plain ? { plain } : {}),
    configFile: inputOr("config-file", DEFAULT_CONFIG_FILE, env),
    manifestFile: inputOr("manifest-file", DEFAULT_MANIFEST_FILE, env),
    releaseWorkflow: inputOr("release-workflow", AUTO, env),
    releasePrs,
    runUrl: input("run-url", env) || defaultRunUrl(env),
    advisories,
    ...(typeOverrides(env) ? { typeOverrides: typeOverrides(env)! } : {}),
    ...(input("release-branch-prefix", env)
      ? { releaseBranchPrefix: input("release-branch-prefix", env) }
      : {}),
    ...(apiUrl ? { apiUrl } : {}),
    ...(graphqlUrl ? { graphqlUrl } : {}),
  });

  writeFileSync(outputFile, outcome.body);
  setOutput("comment-file", outputFile, env);
  setOutput("body", outcome.body, env);
  setOutput("releases", JSON.stringify(outcome.projection.projected), env);
  setOutput("releases-count", String(outcome.projection.projected.length), env);
  setOutput("malformed-title", String(outcome.malformed), env);
  setOutput(
    "recognized-types",
    [...outcome.types.recognized].sort().join(","),
    env,
  );
  if (boolInput("step-summary", true, env)) summary(outcome.body, env);
  // From the outcome rather than the local list: the projection contributes
  // notes of its own, and an advisory that reaches the comment and not the
  // run's annotations is one nobody looking at a red-adjacent check will see.
  for (const advisory of outcome.advisories) warning(advisory.replace(/^- /, ""));

  if (mode === "render-and-comment") {
    await post(client, number, header, outcome.body);
  }
}

/**
 * post writes the sticky comment, and treats being forbidden as a reportable
 * condition rather than a failure.
 *
 * A pull request from a fork carries a read-only token, so the comment cannot
 * be posted from the `pull_request` event at all. Failing the run there would
 * put a red check on every outside contribution over an advisory comment, so
 * the projection is left in the job summary and the run says why.
 */
async function post(
  client: Client,
  number: number,
  header: string,
  body: string,
): Promise<void> {
  try {
    const result = await stick(client, number, header, body);
    notice(`projected-releases comment ${result.action} (#${result.id})`);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      warning(
        "could not post the projected-releases comment: the token cannot" +
          " write to this pull request. A pull request from a fork gets a" +
          " read-only token; see the fork-safe workflow in the README. The" +
          " projection is in this run's job summary.",
      );
      return;
    }
    throw error;
  }
}

/** typeOverrides reads the explicit changelog type lists, when given. */
function typeOverrides(
  env: Env,
): { visible?: readonly string[]; hidden?: readonly string[] } | undefined {
  const visible = listInput("visible-types", env);
  const hidden = listInput("hidden-types", env);
  if (!visible && !hidden) return undefined;
  return { ...(visible ? { visible } : {}), ...(hidden ? { hidden } : {}) };
}

/** MergePlan is which merge the projection should model, and what it was
 * resolved from. */
interface MergePlan {
  /** declared is the `merge-method` input, `auto` included. */
  declared: MergeMethod;
  /** method is the merge the projection models. */
  method: ProjectedMethod;
  /** settings are the repository's, when they were read. */
  settings?: RepositoryMergeSettings;
}

/**
 * mergePlan works out which merge this projection describes. A read that
 * fails costs the repository's own settings, never the comment: the answer
 * falls back to squash, which is what `auto` resolves to for every repository
 * that allows it.
 *
 * `squash` and `rebase` are taken at their word, which is what the input
 * promises: neither needs anything else from the repository. `merge` does,
 * and that is not a loophole. The merge commit's own message is spelled from
 * `merge_commit_title` and `merge_commit_message`, and whether it carries the
 * pull request title decides whether the title releases — so declaring the
 * method without them would swap one guess for another. A read that fails
 * leaves GitHub's own defaults, which is the guess it would have been.
 */
async function mergePlan(client: Client, env: Env): Promise<MergePlan> {
  const declared = inputOr("merge-method", "auto", env);
  if (!isMergeMethod(declared)) {
    throw new Error(
      `input \`merge-method\` must be one of ${MERGE_METHODS.join(", ")}`,
    );
  }
  if (declared === "squash" || declared === "rebase") {
    return { declared, method: declared };
  }

  try {
    const settings = await client.mergeSettings();
    return {
      declared,
      method: projectedMethod({ method: declared, settings }),
      settings,
    };
  } catch (error) {
    warning(`could not read the repository's merge settings: ${String(error)}`);
    return { declared, method: projectedMethod({ method: declared }) };
  }
}

/**
 * API_BRANCH_COMMITS is how many commits the API fallback will pay for.
 *
 * GitHub has no endpoint giving a pull request's commits *with* their files,
 * so the fallback costs one request per commit — on exactly the repositories
 * that cannot check out deeply. A branch longer than this is left unmodelled
 * and said so, rather than modelled quietly at two hundred requests.
 */
const API_BRANCH_COMMITS = 50;

/** BranchInput is the pull request as the branch's commits are read for it. */
interface BranchInput {
  number: number;
  base: string;
  files: string[];
  settings?: RepositoryMergeSettings | undefined;
  pr: Parameters<typeof mergeCommitFor>[0];
}

/**
 * branchInput reads the commits merging would put on the target branch, and
 * adds the merge commit itself for a merge-commit merge.
 *
 * The checkout first, because it is one `git log` and exact. The API is the
 * fallback for the shallow checkout `actions/checkout` produces by default,
 * and it is capped: see API_BRANCH_COMMITS. Undefined from both means the
 * merge cannot be modelled, which `mergeAdvisories` says out loud.
 */
async function branchInput(
  client: Client,
  env: Env,
  method: ProjectedMethod,
  pull: BranchInput,
): Promise<BranchCommit[] | undefined> {
  const source = inputOr("changed-files", "auto", env);
  let commits: BranchCommit[] | undefined;

  if (source !== "api") {
    commits = branchCommits(
      inputOr("diff-base", `origin/${pull.base}`, env),
      inputOr("head", "HEAD", env),
      COMMIT_SEARCH_DEPTH,
    );
  }
  if (!commits && source !== "git") {
    try {
      commits = await client.pullRequestCommits(
        pull.number,
        API_BRANCH_COMMITS,
      );
      if (commits) {
        const many = commits.length === 1 ? "commit" : "commits";
        notice(
          `read the branch's ${commits.length} ${many} from the API, one` +
            " request each for their files. Check the repository out with" +
            " `fetch-depth: 0` to read them locally instead.",
        );
      }
    } catch (error) {
      warning(`could not read the branch's commits: ${String(error)}`);
    }
  }
  if (!commits || commits.length === 0) return undefined;

  // Newest first, so the merge commit goes in front of the commits it merges.
  return method === "merge"
    ? [mergeCommitFor(pull.pr, pull.files, pull.settings), ...commits]
    : commits;
}

/**
 * standingReleasePrs finds the open release pull requests targeting `base`,
 * so a pending version can link to the one holding it. A read that fails
 * costs the links, never the comment.
 *
 * Narrowed to the target branch, because a repository maintaining a `v1.x`
 * branch alongside `master` has a standing release pull request on each and
 * the aggregated ones name no component to tell them apart.
 */
async function standingReleasePrs(
  client: Client,
  env: Env,
  base: string,
): Promise<Map<string, string>> {
  if (!boolInput("link-release-prs", true, env)) return new Map();
  try {
    const prefix = input("release-branch-prefix", env);
    return indexReleasePrs(
      await client.openPullRequests(),
      prefix || undefined,
      base,
    );
  } catch (error) {
    warning(`could not list the open release pull requests: ${String(error)}`);
    return new Map();
  }
}

/**
 * pullRequestFiles lists what the pull request changes, from the checkout
 * when there is a usable one and from the API otherwise.
 *
 * The local diff is preferred because it is exact and free, but it needs a
 * checkout deep enough to hold the merge base, and `actions/checkout` is
 * shallow by default. Rather than making every caller remember
 * `fetch-depth: 0`, a git failure falls through to the API, which is capped
 * at 3000 files and so is the fallback rather than the rule.
 */
async function pullRequestFiles(
  client: Client,
  number: number,
  base: string,
  env: Env,
): Promise<string[]> {
  const source = inputOr("changed-files", "auto", env);
  if (!["auto", "git", "api"].includes(source)) {
    throw new Error("input `changed-files` must be one of auto, git, api");
  }

  if (source !== "api") {
    try {
      return changedFiles(
        inputOr("diff-base", `origin/${base}`, env),
        inputOr("head", "HEAD", env),
      );
    } catch (error) {
      if (source === "git") throw error;
      notice(
        "the checkout has no usable merge base, so the changed-file list" +
          " comes from the API instead. Check the repository out with" +
          " `fetch-depth: 0` to read it locally.",
      );
    }
  }
  return client.pullRequestFiles(number);
}

/** defaultRunUrl points the footer at this run, from the runner's own
 * environment, so the ordinary caller does not have to spell it out. */
function defaultRunUrl(env: Env): string {
  const server = env["GITHUB_SERVER_URL"];
  const repository = env["GITHUB_REPOSITORY"];
  const id = env["GITHUB_RUN_ID"];
  if (!server || !repository || !id) return "";
  return `${server}/${repository}/actions/runs/${id}`;
}
