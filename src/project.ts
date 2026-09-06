/**
 * project runs release-please twice and reports the difference the pull
 * request makes.
 *
 * Once over the target branch as it stands, which is what the standing
 * release pull requests already hold, and once over the target branch with
 * the squash-merge of this pull request on top. Both answers are
 * release-please's own; nothing here recomputes a version.
 *
 * Two passes means two rounds of API reads rather than one. That is a handful
 * of requests against a five-figure hourly budget, and paying it buys the
 * "already pending" column without a second model of what release-please
 * would have said.
 */

import { Manifest } from "release-please";
import type {
  GitHub,
  ReleasePullRequest,
  ReleaserConfig,
  Strategy,
} from "release-please";
import { armBoundaryWatch, drainBoundaries } from "./boundary.js";
import type { UnresolvedBoundary } from "./boundary.js";
import { commitSource } from "./commits.js";
import type { CommitFiles } from "./commits.js";
import { componentOfBranch } from "./conventional.js";
import { ROOT_PACKAGE_PATH, splitFiles } from "./split.js";
import type {
  BranchCommit,
  HeadOverrides,
  ReadHeadFile,
  SyntheticCommit,
} from "./pr-view.js";
import { viewWithPullRequest } from "./pr-view.js";

/** DEFAULT_CONFIG_FILE is release-please's config path. */
export const DEFAULT_CONFIG_FILE = "release-please-config.json";
/** DEFAULT_MANIFEST_FILE is release-please's version manifest path. */
export const DEFAULT_MANIFEST_FILE = ".release-please-manifest.json";

/**
 * COMMIT_SEARCH_DEPTH is how far back a walk may go, and it is
 * release-please's own default written out rather than changed.
 *
 * It is spelled here because the local commit-file index is built to the same
 * depth: an index shallower than the walk would send the walk to the API for
 * the commits it stopped short of, which is the cost it exists to remove.
 */
export const COMMIT_SEARCH_DEPTH = 500;

/**
 * COMMIT_BATCH_SIZE is how many commits one GraphQL page carries.
 *
 * release-please defaults it to 10, which is 42 serial round trips over a
 * 419-commit history and 5 over the same history at 100. It changes nothing
 * about the answer — only how many requests it takes to read the same
 * commits.
 */
export const COMMIT_BATCH_SIZE = 100;

/** PackageConfig is the part of one configured package this preview reads. */
export interface PackageConfig {
  /** path is the directory whose commits the component releases. */
  path: string;
  /** component is the name the component's tags carry. */
  component: string;
  /**
   * releaseComponent is the name release-please attributes its releases to,
   * which is the key a projected release is joined to this package by.
   *
   * It is `component` for an ordinary package, and the empty string for one
   * that keeps the component out of its tags — release-please reports no
   * component for those, whatever the config calls them.
   */
  releaseComponent: string;
  /** current is the manifest version, the base the next bump applies to. */
  current: string | undefined;
  separator: string;
  includeComponent: boolean;
}

/**
 * tagFor spells the git tag release-please creates for a version. Mirrors
 * util/tag-name.ts, which is not exported; a wrong prefix here is visible on
 * sight, unlike a wrong version.
 */
export function tagFor(pkg: PackageConfig, version: string): string {
  if (!pkg.includeComponent || !pkg.component) return `v${version}`;
  return `${pkg.component}${pkg.separator}v${version}`;
}

/**
 * readPackages reads the configured components out of a parsed
 * release-please-config.json and .release-please-manifest.json.
 *
 * Per-package options override the top-level ones, which is how
 * release-please itself resolves them.
 *
 * The config need not name a component at all, and this cannot invent the
 * name release-please would derive for one that does not: that takes the
 * strategy, which takes the repository. `namePackages` fills those in
 * afterwards, from release-please itself.
 */
export function readPackages(
  config: Record<string, unknown>,
  manifest: Record<string, string>,
): PackageConfig[] {
  const packages = (config["packages"] ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const topSeparator = (config["tag-separator"] as string) ?? "-";
  const topInclude = (config["include-component-in-tag"] as boolean) ?? true;

  return Object.keys(packages)
    .sort()
    .map((path) => {
      const pkg = packages[path] ?? {};
      const component = (pkg["component"] as string) ?? "";
      const includeComponent =
        (pkg["include-component-in-tag"] as boolean) ?? topInclude;
      return {
        path,
        component,
        releaseComponent: includeComponent ? component : "",
        current: manifest[path],
        separator: (pkg["tag-separator"] as string) ?? topSeparator,
        includeComponent,
      };
    });
}

/**
 * PlainConfig is release-please's non-manifest mode: one package, configured
 * by the caller rather than by files in the repository.
 *
 * This is what `release-type:` on `release-please-action` selects, and it is
 * how a single-package repository is normally released — there is no
 * release-please-config.json or .release-please-manifest.json to read, so the
 * projection cannot start from files. `Manifest.fromConfig` takes the same
 * configuration directly, and is public surface like `fromManifest`.
 */
export interface PlainConfig extends ReleaserConfig {
  /** path is the directory the single package covers. Defaults to the
   * repository root, which is what a single-package repository means. */
  path?: string;
}

/**
 * PLAIN_INCLUDE_COMPONENT_IN_TAG is what `include-component-in-tag` means
 * when a plain-mode caller does not say.
 *
 * False: a repository releasing one package tags `v1.2.3`, not
 * `name-v1.2.3`. That is release-please's own CLI default outside a manifest
 * (`monorepo-tags`), and it is what a single-package repository does.
 *
 * It has to be spelled out rather than left undefined, because the two halves
 * of one release-please run default it differently. `latestReleaseVersion`
 * reads it off the configuration object, where undefined behaves as false and
 * the tag search accepts `v2.4.1`; `Strategy` defaults it to *true*, and
 * writes notes comparing `widgets-v2.4.1...widgets-v2.5.0`. Unset, both
 * happen, and the comment shows a Tag column and a changelog preview naming
 * different tags for the same release. `project` forwards this value into
 * `Manifest.fromConfig`, so the two agree whichever way it is set.
 */
export const PLAIN_INCLUDE_COMPONENT_IN_TAG = false;

/**
 * plainPackage describes the one package a plain-mode repository has.
 *
 * `current` is left undefined here and filled from the manifest release-please
 * builds: in plain mode the base version comes from the latest tag, which only
 * release-please can resolve. `component` is likewise usually empty and filled
 * by namePackages, since the strategy derives it (a `node` release takes the
 * package.json name).
 */
export function plainPackage(config: PlainConfig): PackageConfig {
  const component = config.component ?? "";
  const includeComponent =
    config.includeComponentInTag ?? PLAIN_INCLUDE_COMPONENT_IN_TAG;
  return {
    path: config.path ?? ROOT_PACKAGE_PATH,
    component,
    releaseComponent: includeComponent ? component : "",
    current: undefined,
    separator: config.tagSeparator ?? "-",
    includeComponent,
  };
}

/**
 * withReleasedVersions fills in each package's current version from the
 * manifest release-please built.
 *
 * In manifest mode the version came from the manifest file and this changes
 * nothing. In plain mode there is no such file: the base version is whatever
 * the latest tag says, which release-please resolves while constructing the
 * manifest and exposes as `releasedVersions`. Without it the "Current" column
 * is blank and the bump cannot be named, since naming it compares the two
 * versions.
 */
export function withReleasedVersions(
  manifest: Manifest,
  packages: readonly PackageConfig[],
): PackageConfig[] {
  const released = manifest.releasedVersions ?? {};
  return packages.map((pkg) =>
    pkg.current === undefined && released[pkg.path]
      ? { ...pkg, current: released[pkg.path]!.toString() }
      : pkg,
  );
}

/**
 * namePackages replaces the configured component names with release-please's
 * own.
 *
 * A package need not declare a component. `release-type: node` derives one
 * from the package.json `name` (minus the scope), and other strategies derive
 * one too. Since a projected release is joined to a package by that name, a
 * package left holding the empty string matches no release: the table comes
 * out empty and the comment says "None" for a pull request that really would
 * cut a tag. Only release-please can say what the name is, so it is asked.
 *
 * `Manifest` builds its strategies internally and does not export them, so
 * this reaches for a private method. That is a seam, but a mild one: the
 * strategies are already built and cached by `buildPullRequests`, and if the
 * method ever goes away the packages keep their configured names — which is
 * exactly what they had before — rather than the run failing. Unlike the
 * synthetic-commit seam, a wrong answer here shows up in the table.
 */
export async function namePackages(
  manifest: Manifest,
  packages: readonly PackageConfig[],
): Promise<PackageConfig[]> {
  const build = (
    manifest as unknown as {
      getStrategiesByPath?: () => Promise<Record<string, Strategy>>;
    }
  ).getStrategiesByPath;
  if (typeof build !== "function") return [...packages];

  try {
    const strategies = await build.call(manifest);
    return await Promise.all(
      packages.map(async (pkg) => {
        const strategy = strategies[pkg.path];
        if (!strategy) return pkg;
        // getBranchComponent is the name release-please knows the package by
        // whether or not it tags with it; getComponent is the empty string
        // when it does not, which is what the releases then carry.
        const [name, releaseComponent] = await Promise.all([
          strategy.getBranchComponent(),
          strategy.getComponent(),
        ]);
        return {
          ...pkg,
          component: pkg.component || name || "",
          releaseComponent: releaseComponent ?? "",
        };
      }),
    );
  } catch {
    return [...packages];
  }
}

/** Release is one component release-please would open a release for. */
export interface Release {
  /** component is the release-please component name. */
  component: string;
  /** version is the version the release would carry. */
  version: string;
  /** notes are the rendered changelog entries, as release-please writes them. */
  notes: string;
}

/**
 * toReleases reads release-please's candidate release pull requests into the
 * flat form the comment renders.
 *
 * One pull request is not one release. Under `separate-pull-requests: true`
 * it is, and the component comes from the branch name, which release-please
 * derives from the base branch and component. The default aggregates every
 * component with pending changes into a single pull request instead: one
 * `releaseData` entry per component, on a branch naming none of them, and no
 * version on the pull request itself. Reading only the branch there would
 * report one release for a merge that cuts several tags, or none at all.
 *
 * So the entries decide whenever they can — they carry both the component and
 * the version — and the pull request's own version is the fallback for the
 * separate case, where it is the authoritative one.
 *
 * The version and the component are answered from different places even
 * there. The version on the pull request is authoritative; the component in
 * the *branch* is not, because release-please names a branch after the
 * package (`getBranchComponent`) and attributes a release to the component
 * its tags carry (`getComponent`), and those differ for a package with
 * `include-component-in-tag: false` — the branch says `acme-api`, the release
 * says nothing at all. Since the entry carries the second one, it wins; the
 * branch is the fallback for a pull request with no entries to read.
 */
export function toReleases(
  prs: readonly ReleasePullRequest[],
  releaseBranchPrefix?: string,
): Release[] {
  const releases: Release[] = [];
  for (const pr of prs) {
    const data = pr.body.releaseData;
    const branchComponent = componentOfBranch(pr.headRefName, releaseBranchPrefix);
    const entries = data.flatMap((entry) => {
      const version = entry.version?.toString();
      return version
        ? [
            {
              component: entry.component ?? branchComponent ?? "",
              version,
              notes: entry.notes.trim(),
            },
          ]
        : [];
    });

    if (entries.length > 1 || (entries.length === 1 && !pr.version)) {
      releases.push(...entries);
      continue;
    }

    const version = pr.version?.toString();
    if (!version) continue;
    releases.push({
      component: data[0]?.component ?? branchComponent ?? "",
      version,
      notes: data
        .map((d) => d.notes.trim())
        .filter(Boolean)
        .join("\n\n"),
    });
  }
  return releases;
}

/**
 * Unresolved is a component release-please found no release boundary for,
 * and which side of the merge it was missing on.
 *
 * The two passes read different manifests -- the pull request's copy and the
 * target branch's -- so one can resolve while the other does not. That is the
 * ordinary shape of a repair in progress: the pull request that fixes the
 * manifest sees a resolved boundary on its own branch and a broken one on the
 * branch it targets.
 */
export interface Unresolved extends UnresolvedBoundary {
  /** on is where the manifest entry with no release was read: this pull
   * request's copy, the target branch's, or both. */
  on: "head" | "base" | "both";
}

/** Projection is everything the comment needs to describe a pull request. */
export interface Projection {
  /** packages are the configured components and their manifest versions. */
  packages: PackageConfig[];
  /** touched maps a package path to the pull request's files under it. */
  touched: Map<string, string[]>;
  /** files are every path the pull request changes, owned or not. Needed to
   * say which directories a pull request that touches no component hit. */
  files: string[];
  /** projected is what merging this pull request leads to, per component. */
  projected: Release[];
  /** pending is what the target branch already releases without it. */
  pending: Release[];
  /**
   * unresolved are the components release-please could not find a release
   * boundary for, whose versions above are therefore computed over the
   * component's whole history. See boundary.ts.
   */
  unresolved: Unresolved[];
  /** releaseAs is the version a `Release-As:` line in the body asked for. */
  releaseAs?: string;
  /**
   * ignoredReleaseAs is a `Release-As:` version release-please did not
   * honour, which happens silently when non-trailer text follows the note.
   * Observed by comparing the versions release-please actually returned
   * against the one the note asked for, rather than by mirroring the
   * trailer-placement rule that decides it.
   */
  ignoredReleaseAs?: string;
}

/** ProjectOptions are the inputs to a projection. */
export interface ProjectOptions {
  github: GitHub;
  commit: SyntheticCommit;
  config: Record<string, unknown>;
  manifest: Record<string, string>;
  configFile?: string;
  manifestFile?: string;
  /**
   * plain selects release-please's non-manifest mode. When set, `config` and
   * `manifest` are unused and the single package is configured from here
   * instead — the same choice `release-type:` makes on release-please-action.
   */
  plain?: PlainConfig;
  /** releaseBranchPrefix is how release-please names its release branches,
   * which is how a candidate release is attributed to a component. */
  releaseBranchPrefix?: string;
  /** readHeadFile serves the pull request's version of a file release-please
   * reads from the target branch. See ReadHeadFile in pr-view.ts. */
  readHeadFile?: ReadHeadFile;
  /** commitFiles answers a commit's file list without the API, when the
   * caller has a checkout that can. See CommitFiles in commits.ts. */
  commitFiles?: CommitFiles;
  /**
   * branch are the commits merging puts on the target branch individually,
   * newest first, for a repository that merges or rebases rather than
   * squashes. Given none, the squash-merge of `commit` is what is modelled.
   */
  branch?: readonly BranchCommit[];
}

// A `Release-As:` note on a line of its own. The key is matched
// case-insensitively because release-please lowercases the footer token
// before comparing it, and `release-as: 1.2.3` is honoured (measured).
const RELEASE_AS_LINE = /^release-as:[ \t]*(\S.*?)[ \t]*$/i;

// A fenced code block's opening or closing line, indented up to three spaces
// as CommonMark allows.
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

// release-please reads the version out of a note with an unanchored match
// (util/version.ts VERSION_REGEX), so `Release-As: 1.1.1 was the old one`
// forces 1.1.1 rather than failing. SEEN mirrors that; MEANT is the anchored
// form, which is what a note someone wrote on purpose looks like.
const SEEN = /\d+\.\d+\.\d+(?:-[^+\s]+)?(?:\+\S+)?/;
const MEANT = /^\d+\.\d+\.\d+(?:-[^+\s]+)?(?:\+\S+)?$/;

/** ReleaseAsNotes are the `Release-As:` notes a pull request body carries. */
export interface ReleaseAsNotes {
  /**
   * seen is every version a note in the body could be read as asking for, in
   * document order. Permissive: it exists to recognize that release-please
   * honoured *one* of them, and a note that forced a version is not an
   * ignored note whichever line it came from.
   */
  seen: string[];
  /**
   * meant is the note the pull request can fairly be said to have asked for,
   * or undefined when nothing in the body qualifies. Strict: only this one
   * can raise the "was ignored" warning, which is why the bar is a line
   * someone plausibly wrote as a trailer rather than any mention at all.
   */
  meant: string | undefined;
}

/**
 * releaseAsNotes reads the `Release-As:` notes out of a pull request body.
 *
 * Whether release-please honours a note is not decided here — that is
 * observed afterwards, from the versions it returned. What is decided here is
 * narrower and still needed: which lines were notes at all. A body that
 * *discusses* the trailer is not asking for a version, and in a repository
 * whose contributors have been bitten by the placement rule that body is
 * ordinary, so a mention must be able to stay a mention.
 *
 * A mention stays a mention by being quoted the way prose quotes anything:
 * inside a code fence, in backticks, in a blockquote, or indented. Only a
 * line beginning at column 0 with nothing after the version counts, and a
 * placeholder such as `Release-As: x.y.z` counts as nothing at all, since
 * release-please could not have parsed it as a version.
 *
 * What is deliberately *not* excluded is a qualifying line in the middle of a
 * body. It is the exact shape of the failure this warns about — a note with
 * non-trailer text below it, which release-please drops in silence — so it is
 * read as a note that will be ignored rather than as prose.
 */
export function releaseAsNotes(body: string): ReleaseAsNotes {
  const seen: string[] = [];
  const meant: string[] = [];
  let fence: string | undefined;

  for (const line of body.split(/\r?\n/)) {
    const marker = FENCE.exec(line)?.[1];
    if (marker) {
      // CommonMark closes a fence with the same character, at least as long
      // as the one that opened it. Keeping only the character let a
      // three-backtick line close a four-backtick fence, so a body that
      // quotes a fenced ```` ```Release-As: 1.2.3``` ```` example came apart
      // at the inner fence and the note inside it was read as a real one --
      // raising the "was ignored" warning on a pull request that never asked
      // for a version.
      if (fence === undefined) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (fence !== undefined) continue;

    const value = RELEASE_AS_LINE.exec(line)?.[1];
    if (value === undefined) continue;
    const version = SEEN.exec(value)?.[0];
    if (!version) continue;
    seen.push(version);
    if (MEANT.test(value)) meant.push(version);
  }

  // The last one, because a trailer sits at the end of a message: an earlier
  // line saying what the version used to be is not the ask.
  return { seen, meant: meant[meant.length - 1] };
}

/**
 * project runs both passes and assembles the result.
 *
 * The head's config and manifest are served to the pull request pass, because
 * after the merge those are the files master carries: a branch that adds a
 * component should preview as adding one. The target-branch pass reads the
 * target branch normally, since that is the state it describes.
 */
export async function project(options: ProjectOptions): Promise<Projection> {
  const configFile = options.configFile ?? DEFAULT_CONFIG_FILE;
  const manifestFile = options.manifestFile ?? DEFAULT_MANIFEST_FILE;
  // Resolved once, so the package this describes and the manifest
  // release-please builds are configured from the same object. See
  // PLAIN_INCLUDE_COMPONENT_IN_TAG for why the default has to be written in
  // rather than left for release-please to supply.
  const plain: PlainConfig | undefined = options.plain
    ? {
        ...options.plain,
        includeComponentInTag:
          options.plain.includeComponentInTag ?? PLAIN_INCLUDE_COMPONENT_IN_TAG,
      }
    : undefined;
  const declared = plain
    ? [plainPackage(plain)]
    : readPackages(options.config, options.manifest);

  // Plain mode has no config or manifest file to override -- the
  // configuration came from the caller. It still reads a file, though: the
  // release strategy opens the package file on the target branch to derive
  // the component name, which `readHeadFile` serves from the head.
  const overrides: HeadOverrides = plain
    ? {}
    : {
        [configFile]: options.config,
        [manifestFile]: options.manifest,
      };

  // An override wins over anything the repository's own config says, so a
  // repository that has tuned either of these keeps its value: the projection
  // has to describe the release-please run the merge will get, not a
  // differently configured one. Plain mode has no config file to tune them in.
  const tuned = plain ? {} : options.config;
  const manifestOptions = {
    ...(tuned["commit-search-depth"] === undefined
      ? { commitSearchDepth: COMMIT_SEARCH_DEPTH }
      : {}),
    ...(tuned["commit-batch-size"] === undefined
      ? { commitBatchSize: COMMIT_BATCH_SIZE }
      : {}),
  };

  /** build makes a Manifest the way this repository is configured. Both
   * statics are release-please's public surface. */
  const build = (github: GitHub): Promise<Manifest> =>
    plain
      ? Manifest.fromConfig(
          github,
          options.commit.baseBranch,
          plain,
          manifestOptions,
          plain.path ?? ROOT_PACKAGE_PATH,
        )
      : Manifest.fromManifest(
          github,
          options.commit.baseBranch,
          configFile,
          manifestFile,
          manifestOptions,
        );

  // Both passes read the target branch through one walk, cached between them,
  // and both serve file lists from the checkout when there is one.
  const source = commitSource(
    options.github,
    options.commitFiles ? { files: options.commitFiles } : {},
  );

  const view = viewWithPullRequest(
    source,
    options.commit,
    overrides,
    options.readHeadFile,
    options.branch,
  );
  // Armed before the first pass and drained after each, so a boundary the
  // pull request resolves is not reported against the branch that resolved it.
  armBoundaryWatch();
  drainBoundaries();

  const withPr = await build(view.github);
  const prefix = options.releaseBranchPrefix;
  const projected = toReleases(await withPr.buildPullRequests(), prefix);
  view.assertConsulted();
  const unresolvedHead = drainBoundaries();

  // After the pull requests are built, so the strategies this reads are the
  // ones release-please has already constructed and cached.
  const packages = withReleasedVersions(
    withPr,
    await namePackages(withPr, declared),
  );

  // The target branch may not be configured for release-please at all: a pull
  // request that introduces it, or introduces the package file its strategy
  // reads, has a base where `fromConfig` cannot build a manifest. That is not
  // an error and it is not unknown -- a branch release-please cannot run on
  // releases nothing, which is what an empty `pending` says. Adopting
  // release-please is exactly this shape, so it must not fail the run.
  let pending: Release[] = [];
  let unresolvedBase: UnresolvedBoundary[] = [];
  try {
    const withoutPr = await build(source);
    pending = toReleases(await withoutPr.buildPullRequests(), prefix);
    unresolvedBase = drainBoundaries();
  } catch (error) {
    console.error(
      "could not build releases for the target branch, so nothing is" +
        ` pending there: ${String(error)}`,
    );
  }

  const touched = splitFiles(
    options.commit.files,
    packages.map((p) => p.path),
  );

  // Where a `Release-As:` note could be written is whatever merging turns
  // into a commit message: the pull request body under squash-merge, and each
  // of the branch's own commit messages otherwise. Read separately rather
  // than concatenated, because a trailer at the end of one commit is a
  // trailer, and joining it to the next message would make it look like the
  // mid-body note the warning below exists to catch.
  //
  // The body is read under a merge or a rebase as well, and it is the case
  // that most needs reading: there the description reaches a commit message
  // only where the merge commit is configured to carry it, so under GitHub's
  // default `merge_commit_message: PR_TITLE` a note written there asks for a
  // version nothing will ever parse. Unread, that is silent -- the same
  // silence as the placement rule, arrived at a different way. Read, it is a
  // note release-please did not honour, which is what the warning says. It
  // goes last so a trailer on a real commit is still the one `asked` names.
  const sources = options.branch?.length
    ? [...options.branch.map((c) => c.message), options.commit.body]
    : [options.commit.body];
  const notes = sources.map(releaseAsNotes);
  // A note was honoured when release-please returned the version it names.
  // Any note will do for that: honouring the wrong one is still not ignoring
  // the ask, and reporting the note that was ignored is the whole point of
  // the warning.
  const seen = notes.flatMap((n) => n.seen);
  const meant = notes.map((n) => n.meant).find((v) => v !== undefined);
  const honoured = seen.find((v) => projected.some((r) => r.version === v));
  const asked = honoured ?? meant;
  const ignoredReleaseAs =
    !honoured && meant && touched.size > 0 ? meant : undefined;

  return {
    packages,
    touched,
    files: [...options.commit.files],
    projected,
    pending,
    unresolved: mergeUnresolved(unresolvedHead, unresolvedBase),
    ...(asked ? { releaseAs: asked } : {}),
    ...(ignoredReleaseAs ? { ignoredReleaseAs } : {}),
  };
}

/**
 * mergeUnresolved joins the two passes' findings into one list per component.
 *
 * A component missing on both sides is one fact about the repository, not two
 * about the run, so it is reported once. The `on` field is what survives of
 * the distinction, and it is worth keeping: a boundary broken only on the
 * target branch says the pull request is the repair.
 */
export function mergeUnresolved(
  head: readonly UnresolvedBoundary[],
  base: readonly UnresolvedBoundary[],
): Unresolved[] {
  const byPath = new Map<string, Unresolved>();
  const add = (found: UnresolvedBoundary, on: "head" | "base") => {
    const already = byPath.get(found.path);
    if (!already) byPath.set(found.path, { ...found, on });
    else if (already.on !== on) already.on = "both";
  };
  for (const found of head) add(found, "head");
  for (const found of base) add(found, "base");
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}
