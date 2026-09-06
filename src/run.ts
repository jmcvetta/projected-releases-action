/**
 * run is the whole job in one function, shared by the action and the CLI.
 *
 * Both entry points do the same thing and differ only in where the inputs
 * come from: the action reads them from the runner and the webhook payload,
 * the CLI from flags. Keeping the work here means driving the tool by hand
 * from a checkout exercises the same code path a pull request does, which is
 * how a projection gets compared against the merge that follows it.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GitHub } from "release-please";
import type { GitHub as GitHubType } from "release-please";
import { watchBoundaries } from "./boundary.js";
import { isMalformed, resolveTypes } from "./conventional.js";
import type { TypeSet } from "./conventional.js";
import { commitFileIndex } from "./git.js";
import {
  project,
  COMMIT_SEARCH_DEPTH,
  DEFAULT_CONFIG_FILE,
  DEFAULT_MANIFEST_FILE,
} from "./project.js";
import type { PlainConfig, Projection } from "./project.js";
import type { BranchCommit } from "./pr-view.js";
import { render } from "./render.js";
import { compareReleaseWorkflow } from "./workflow.js";

/** EMPTY is the projection rendered when the title is withheld from one. */
const EMPTY: Projection = {
  packages: [],
  touched: new Map(),
  files: [],
  projected: [],
  pending: [],
  unresolved: [],
};

/** RunOptions are everything a projection needs, from either entry point. */
export interface RunOptions {
  owner: string;
  repo: string;
  token: string;
  /** apiUrl is the REST root release-please reads through, for GitHub
   * Enterprise Server. Undefined means github.com. */
  apiUrl?: string | undefined;
  /** graphqlUrl is the GraphQL endpoint, for GitHub Enterprise Server, where
   * it is not derivable from the REST root. */
  graphqlUrl?: string | undefined;
  /** title is the pull request title, which squash-merge makes the subject. */
  title: string;
  /** body is the pull request description, which becomes the commit body. */
  body: string;
  /** number is the pull request number, so changelog lines can link to it. */
  number: number;
  /** base is the branch the pull request targets, by name. */
  base: string;
  /** headSha is the commit the projection describes. */
  headSha: string;
  /** headBranch is the pull request's head branch. */
  headBranch: string;
  /** files are the paths the pull request changes. */
  files: string[];
  /**
   * branch are the commits merging puts on the target branch individually,
   * newest first, for a repository that merges or rebases rather than
   * squashes. Given none, the squash-merge of the title and body is what is
   * modelled -- which is the ordinary case and this action's whole original
   * subject.
   */
  branch?: readonly BranchCommit[];
  /** repoRoot is the checkout the config and manifest are read from. */
  repoRoot?: string;
  /**
   * baseRef is the target branch as the checkout names it, which is where the
   * commit-file index is read from. Defaults to `origin/<base>`, the same ref
   * the changed-file diff runs against.
   */
  baseRef?: string;
  /**
   * plain selects release-please's non-manifest mode: one package configured
   * here rather than by a release-please-config.json in the checkout. Nothing
   * is read from disk when it is set.
   */
  plain?: PlainConfig | undefined;
  configFile?: string;
  manifestFile?: string;
  /**
   * releaseWorkflow is where the workflow calling release-please-action is:
   * `auto` scans `.github/workflows` under `repoRoot`, `off` reads nothing,
   * and anything else is one workflow's path. Reading it turns a second copy
   * of this repository's release configuration into something the projection
   * can check itself against.
   */
  releaseWorkflow?: string | undefined;
  /** releasePrs maps a component to its standing release pull request URL. */
  releasePrs?: Map<string, string>;
  /** runUrl is this workflow run, linked from the comment's footer. */
  runUrl?: string;
  /** typeOverrides force the changelog type list, when a caller knows better
   * than the config does. */
  typeOverrides?: { visible?: readonly string[]; hidden?: readonly string[] };
  /** releaseBranchPrefix is how release-please names its release branches. */
  releaseBranchPrefix?: string;
  /** advisories are notes the caller found that the projection cannot see,
   * chiefly about how the repository merges. */
  advisories?: readonly string[];
  /** now is the render time; injected so the footer is testable. */
  now?: Date;
  /**
   * github replaces the client this would otherwise build from `owner`,
   * `repo` and `token`. Injected so the whole path from options to rendered
   * markdown can be tested against a fixture repository, which is the only
   * way to test what release-please actually does with one.
   */
  github?: GitHubType;
}

/** Outcome is the rendered comment plus what it was rendered from. */
export interface Outcome {
  /** body is the comment markdown. */
  body: string;
  /** projection is what release-please returned, empty when withheld. */
  projection: Projection;
  /** malformed reports that the projection was withheld. */
  malformed: boolean;
  /** types is the changelog type list this run resolved. */
  types: TypeSet;
  /**
   * advisories are the notes rendered above the projection: the caller's,
   * plus any this run found itself. The action re-emits them as runner
   * annotations, so a note has to come back out rather than only reaching
   * the comment.
   */
  advisories: readonly string[];
}

/**
 * graphqlRoot normalizes a GraphQL URL to the form release-please wants.
 *
 * release-please hands the value to Octokit as `baseUrl`, and Octokit appends
 * `/graphql` to it -- so its own default is `https://api.github.com`, the API
 * root, not the endpoint. A runner's `GITHUB_GRAPHQL_URL` is the endpoint
 * (`https://api.github.com/graphql`), and so is `${{ github.graphql_url }}`,
 * which is the obvious thing for a caller to pass. Handing either through
 * unchanged produces `https://api.github.com/graphql/graphql` and a bare
 * `HttpError: Not Found` from the first merge-commit query.
 *
 * Found by running the action on its own pull request, which is the only
 * place this could be found: every test drives a fixture `GitHub` that is
 * never constructed from a URL.
 */
export function graphqlRoot(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/graphql$/, "");
}

/**
 * quietLogger sends release-please's logging to stderr, and watches it on the
 * way past for the unresolved-boundary lines the comment warns about.
 *
 * release-please logs to stdout by default, which for the CLI would land in
 * the middle of the comment body it prints there. On a runner both streams
 * reach the same log, so nothing is lost either way.
 */
export function quietLogger(): void {
  const toStderr = (...args: unknown[]) => console.error(...args);
  watchBoundaries({
    debug: toStderr,
    info: toStderr,
    warn: toStderr,
    error: toStderr,
    trace: toStderr,
    fatal: toStderr,
  } as Parameters<typeof watchBoundaries>[0]);
}

/**
 * missingConfig explains a manifest-mode read that found no file.
 *
 * This is the implicit half of the mode switch seen from the other side: the
 * caller passed no `release-type`, so the projection went looking for the
 * files, and a repository that releases without them has none. The bare
 * ENOENT names the file and nothing else, which leaves the reader to work out
 * that a missing file is how one mode is selected.
 *
 * Only when *neither* file is there, though. One of the two present is a
 * manifest-mode repository missing half its configuration, and telling that
 * repository to switch modes would be the confidently wrong answer this
 * action exists to avoid giving.
 */
function missingConfig(path: string, root: string, counterpart?: string): string {
  if (counterpart) {
    return (
      `no \`${path}\` in \`${root}\`, though \`${counterpart}\` is there.` +
      " release-please's manifest mode reads both of them and this repository" +
      " has one, so nothing here can say what it releases."
    );
  }
  return (
    `no \`${path}\` in \`${root}\`. release-please reads that file unless the` +
    " release workflow passes it a `release-type:`, in which case there is no" +
    " file and the configuration is on the workflow -- pass this action the" +
    " same `release-type` and it will model that instead. If the repository" +
    " does have one, point `repo-root` at the checkout holding it."
  );
}

/** ModeContext is the checkout a mode was selected against. */
interface ModeContext {
  /** plain is whether `release-type` selected the non-manifest mode. */
  plain: boolean;
  /** root is the checkout the two files are looked for in. */
  root: string;
  configFile: string;
  manifestFile: string;
}

/**
 * modeAdvisories reports a checkout that contradicts the mode selected.
 *
 * `release-type` is the switch, and its *presence* is the whole of it: set,
 * the configuration comes from the caller and the repository's own files are
 * not read. That is release-please-action's rule and this action copies it,
 * so a repository setting both gets the same answer from both -- but only if
 * the release workflow sets both too. Set here and not there, release-please
 * reads the files this projection ignored, and the projection describes a
 * configuration that will never run.
 *
 * Which of those two it is is a question about a workflow file, and
 * `compareReleaseWorkflow` answers it whenever that file can be found and
 * read. This is what is left when it cannot: a note saying what is true
 * either way, leaving the reading to the reader, as the boundary warning
 * does. buildComment calls one or the other, never both.
 *
 * No checkout at all is not this condition. A run with `changed-files: api`
 * and no `actions/checkout` finds nothing, which is indistinguishable from a
 * repository that has no such files -- and that repository is the one plain
 * mode is for, so silence is right.
 */
function modeAdvisories(context: ModeContext): string[] {
  if (!context.plain) return [];
  const found = [context.configFile, context.manifestFile].filter((path) =>
    existsSync(resolve(context.root, path)),
  );
  if (found.length === 0) return [];
  const names = found.map((path) => `\`${path}\``).join(" and ");
  return [
    `- \`release-type\` is set, so this projection is release-please's` +
      ` non-manifest mode and the ${names} in the checkout ${found.length > 1 ? "were" : "was"}` +
      " not read. release-please does the same when its own workflow passes" +
      " `release-type:`, and reads the file when it does not -- so if the" +
      " release workflow has no `release-type:`, this projection describes a" +
      " different configuration from the one that will run. Clearing" +
      " `release-type` here reads the files instead.",
  ];
}

/**
 * buildComment renders the projected-releases comment for one pull request.
 *
 * A malformed title short-circuits the whole thing: such a title is not
 * mergeable under a title gate and misleading without one, so a projection
 * from it describes a commit that will never exist. Nothing is worth
 * fetching.
 */
export async function buildComment(options: RunOptions): Promise<Outcome> {
  const root = options.repoRoot ?? ".";
  const configFile = options.configFile ?? DEFAULT_CONFIG_FILE;
  const manifestFile = options.manifestFile ?? DEFAULT_MANIFEST_FILE;
  const readJson = (path: string, counterpart: string) => {
    const full = resolve(root, path);
    // A missing file here is the mode switch read the wrong way round, and
    // the bare ENOENT says nothing about that. See modeAdvisories.
    if (!existsSync(full)) {
      const other = existsSync(resolve(root, counterpart)) ? counterpart : undefined;
      throw new Error(missingConfig(path, root, other));
    }
    return JSON.parse(readFileSync(full, "utf8")) as Record<string, unknown>;
  };

  // Plain mode has no files to read. The empty objects stand in so the rest
  // of the pipeline keeps one shape; `project` ignores them when `plain` is
  // set.
  const config = options.plain ? {} : readJson(configFile, manifestFile);
  const manifest = options.plain
    ? {}
    : (readJson(manifestFile, configFile) as Record<string, string>);

  // The release workflow answers the mode question outright when it can be
  // read, so the checkout-only guess below is made only when it cannot.
  const workflow = compareReleaseWorkflow({
    ...(options.plain ? { plain: options.plain } : {}),
    configFile,
    manifestFile,
    base: options.base,
    root,
    ...(options.releaseWorkflow ? { workflow: options.releaseWorkflow } : {}),
  });

  const advisories = [
    ...(options.advisories ?? []),
    ...workflow.notes,
    ...(workflow.decided
      ? []
      : modeAdvisories({
          plain: options.plain !== undefined,
          root,
          configFile,
          manifestFile,
        })),
  ];

  const types = resolveTypes({
    // A plain-mode caller declares its changelog sections on the releaser
    // config rather than in a file, and they mean the same thing: the
    // types this repository's changelog recognizes.
    config: options.plain?.changelogSections
      ? { "changelog-sections": options.plain.changelogSections }
      : config,
    ...(options.typeOverrides?.visible
      ? { visible: options.typeOverrides.visible }
      : {}),
    ...(options.typeOverrides?.hidden
      ? { hidden: options.typeOverrides.hidden }
      : {}),
    ...(options.releaseBranchPrefix
      ? { releaseBranchPrefix: options.releaseBranchPrefix }
      : {}),
  });

  // The title is only the input under squash-merge. Where the branch's own
  // commits are what release-please will parse, a title that is not a
  // Conventional Commit describes nothing that will ever be a commit message,
  // so withholding the projection over it would withhold the answer to the
  // question the repository actually asks.
  const commitMessages = options.branch?.length
    ? options.branch.map((commit) => commit.message)
    : undefined;
  const malformed = commitMessages ? false : isMalformed(options.title, types);

  const projection = malformed
    ? EMPTY
    : await projectPullRequest(options, config, manifest, {
        configFile,
        manifestFile,
        releaseBranchPrefix: types.releaseBranchPrefix,
      });

  const body = render(projection, {
    title: options.title,
    malformed,
    types,
    ...(commitMessages ? { commitMessages } : {}),
    ...(options.releasePrs ? { releasePrs: options.releasePrs } : {}),
    ...(options.headSha ? { headSha: options.headSha } : {}),
    ...(options.runUrl ? { runUrl: options.runUrl } : {}),
    ...(advisories.length ? { advisories } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  return { body, projection, malformed, types, advisories };
}

async function projectPullRequest(
  options: RunOptions,
  config: Record<string, unknown>,
  manifest: Record<string, string>,
  files: {
    configFile: string;
    manifestFile: string;
    releaseBranchPrefix: string;
  },
): Promise<Projection> {
  const github =
    options.github ??
    (await GitHub.create({
      owner: options.owner,
      repo: options.repo,
      defaultBranch: options.base,
      ...(options.token ? { token: options.token } : {}),
      ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
      ...(options.graphqlUrl
      ? { graphqlUrl: graphqlRoot(options.graphqlUrl) }
      : {}),
    }));

  // The checkout's answer to "what did this commit change", when it has one.
  // Missing shas and a checkout that cannot answer both fall through to
  // release-please's own backfill, one REST call at a time.
  const index = commitFileIndex(
    [options.baseRef ?? `origin/${options.base}`, options.base, "HEAD"],
    COMMIT_SEARCH_DEPTH,
  );

  return project({
    github,
    config,
    manifest,
    ...(index ? { commitFiles: (sha: string) => index.get(sha) } : {}),
    configFile: files.configFile,
    manifestFile: files.manifestFile,
    releaseBranchPrefix: files.releaseBranchPrefix,
    // Serve the head's copy of any file the pull request changes. release-please
    // reads the package file from the target branch to name the component, and a
    // pull request that adds it -- adopting release-please -- has a target branch
    // without it. After the merge, the head's copy is the one that branch has.
    readHeadFile: (path: string) => {
      if (!options.files.includes(path)) return undefined;
      const full = resolve(options.repoRoot ?? ".", path);
      return existsSync(full) ? readFileSync(full, "utf8") : undefined;
    },
    ...(options.plain ? { plain: options.plain } : {}),
    ...(options.branch?.length ? { branch: options.branch } : {}),
    commit: {
      title: options.title,
      body: options.body,
      files: options.files,
      number: options.number,
      headSha: options.headSha || "0".repeat(40),
      headBranch: options.headBranch || "HEAD",
      baseBranch: options.base,
    },
  });
}
