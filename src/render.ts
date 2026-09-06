/**
 * render writes the sticky comment body.
 *
 * It is tool output, not a message: one table carrying the numbers and tag of
 * every package this pull request affects — and only the notes needed to read
 * it. A line above the table says why nothing releases, which no row can; when
 * something does release, the row says it all and there is no line. Most pull
 * requests in a repository like this one release nothing at all, so "nothing
 * will be released" is stated as an answer rather than left as silence — and
 * stated in the line alone, because a table with no version in it is a table
 * the reader has to check before learning there was nothing to check.
 *
 * What it does not do is explain release-please. Which types release, what a
 * changelog section is, how a manifest names its packages: release-please
 * documents all of it, and a comment that documents it again is longer,
 * duplicated, and wrong the day the upstream default changes.
 *
 * Packages the pull request neither touches nor releases are accounted for in
 * one line below the table rather than one row each, so the comment's length
 * follows the change rather than the repository.
 *
 * The table is the work product and is never collapsed. What is collapsed is
 * genuinely secondary: the changelog preview, and the per-file listing behind
 * the table's file counts.
 */

import { DEFAULT_TYPES, titleType } from "./conventional.js";
import type { TypeSet } from "./conventional.js";
import type { PackageConfig, Projection, Release } from "./project.js";
import { tagFor } from "./project.js";
import { ROOT_PACKAGE_PATH } from "./split.js";

/** RenderOptions are the pull request facts the body is stamped with. */
export interface RenderOptions {
  /** title is the pull request title, which squash-merge makes the subject. */
  title: string;
  /** malformed withholds the projection: see conventional.isMalformed. */
  malformed: boolean;
  /**
   * commitMessages are the messages of the commits merging will write, when
   * those are what release-please will parse rather than the title — which is
   * what a merge-commit or rebase merge does. Absent means the title is the
   * input, which is squash-merge and the ordinary case.
   *
   * It exists because the lines that explain an empty answer name their
   * input: "`chore:` produces no release" is a true and useful sentence about
   * a squash-merge and a wrong one about a repository where the title is not
   * a commit at all.
   */
  commitMessages?: readonly string[];
  /** releasePrs maps a component to its standing release pull request URL. */
  releasePrs?: Map<string, string>;
  /** headSha is the commit the projection describes. */
  headSha?: string;
  /** runUrl is this workflow run, linked from the footer. */
  runUrl?: string;
  /** types is the resolved changelog type list, which decides what "visible"
   * means for this repository. Defaults to the conventionalcommits preset. */
  types?: TypeSet;
  /**
   * advisories are warnings the caller found that the projection itself
   * cannot see — chiefly that the repository will not build the merge commit
   * this preview assumes. Rendered with the projection's own warnings.
   */
  advisories?: readonly string[];
  /** now is the render time; injected so the footer is testable. */
  now?: Date;
}

/**
 * subjectsOf is every line release-please might read a Conventional Commit
 * off: the title where the title is the input, and otherwise each paragraph
 * of each commit message merging writes.
 *
 * Paragraphs rather than subjects alone, because release-please's
 * `splitMessages` treats a paragraph beginning with a Conventional Commit
 * type as a commit of its own — which is exactly how GitHub's default merge
 * commit contributes the pull request title from below a subject that parses
 * as nothing. Mirroring that rule is acceptable here for the reason split.ts
 * gives for mirroring its own: it decides which sentence explains an empty
 * answer, never a version. Getting it wrong costs a word.
 */
function subjectsOf(options: RenderOptions): readonly string[] {
  if (!options.commitMessages) return [options.title];
  return options.commitMessages.flatMap((message) =>
    message.split(/\r?\n\s*\r?\n/).flatMap((paragraph) => {
      const first = paragraph.trim().split("\n", 1)[0];
      return first ? [first] : [];
    }),
  );
}

/** visibleInput reports whether anything release-please will parse carries a
 * type that renders a changelog line, and so can open a release on its own. */
function visibleInput(options: RenderOptions): boolean {
  const types = options.types ?? DEFAULT_TYPES;
  return subjectsOf(options).some((subject) =>
    types.visible.has(titleType(subject) ?? ""),
  );
}

/**
 * Row is one package's line in the table.
 *
 * A row is built for every configured package, but only the ones this pull
 * request has something to do with are rendered: see `affected`.
 */
interface Row {
  pkg: PackageConfig;
  /** projected is the release merging this pull request leads to, if any. */
  projected: Release | undefined;
  /** pending is what the target branch releases without it, if anything. */
  pending: Release | undefined;
  /** files are this pull request's files that fall under the package. */
  files: readonly string[];
}

/** MovedRow is a row whose version this pull request changes, so it has a
 * projected release and a tag to name. */
type MovedRow = Row & { projected: Release };

/**
 * footer stamps the comment with what it was rendered from.
 *
 * A sticky comment is edited in place, so a re-render posts no new comment,
 * sends no notification, and does not move in the thread. When the verdict is
 * unchanged — which it is for every title edit that does not cross the
 * hidden/visible line — nothing on screen distinguishes a fresh render from a
 * stale one. This line is the difference.
 */
export function footer(options: RenderOptions): string {
  const parts: string[] = [];
  if (options.headSha) parts.push(`\`${options.headSha.slice(0, 7)}\``);
  const stamp = (options.now ?? new Date())
    .toISOString()
    .replace("T", " ")
    .slice(0, 16);
  parts.push(
    options.runUrl
      ? `[re-rendered ${stamp} UTC](${options.runUrl})`
      : `re-rendered ${stamp} UTC`,
  );
  return `<sub>Projected for ${parts.join(" · ")}</sub>`;
}

/**
 * renderWithheld replaces the projection when the title is malformed.
 *
 * Such a title is not mergeable as written, so a projection from it describes
 * a commit that will never exist. The reader needs to know it is wrong and
 * what shape it should be; what release-please does with it is not their
 * problem here.
 */
function renderWithheld(options: RenderOptions): string[] {
  const types = options.types ?? DEFAULT_TYPES;
  const recognized = [...types.recognized]
    .sort()
    .map((t) => `\`${t}\``)
    .join(", ");
  return [
    "## Projected releases",
    "",
    "None — malformed PR title.",
    "",
    `> ${options.title}`,
    "",
    "Titles must be [Conventional Commits](https://www.conventionalcommits.org/)" +
      " format, with a lowercase type the changelog recognizes:" +
      ` ${recognized}.`,
  ];
}

/**
 * render writes the whole comment body for a projection.
 */
export function render(
  projection: Projection,
  options: RenderOptions,
): string {
  const lines = options.malformed
    ? [
        ...renderWithheld(options),
        // Advisories survive a withheld projection: "this repository does not
        // squash-merge" is as true of a malformed title as of a good one, and
        // it is the note most likely to explain why the whole comment is
        // beside the point.
        ...(options.advisories?.length ? ["", ...options.advisories] : []),
      ]
    : renderProjection(projection, options);
  return [...lines, "", footer(options)].join("\n") + "\n";
}

function renderProjection(
  projection: Projection,
  options: RenderOptions,
): string[] {
  const { rows, unmatched } = buildRows(projection);

  const touchedPackages = [...projection.touched.keys()].flatMap((path) => {
    const pkg = projection.packages.find((p) => p.path === path);
    return pkg ? [pkg] : [];
  });
  const touched = new Set(touchedPackages.map((p) => p.releaseComponent));

  // A moved version is this pull request's doing whatever files it changed:
  // the two passes differ only by the merge, so nothing else could have moved
  // it. release-please attributes releases itself, and its `node-workspace`
  // and `linked-versions` plugins release components a pull request never
  // touches — which a filter on the touched components dropped, understating
  // the merge or reporting nothing for it at all.
  //
  // A version that does not move is another matter. That release is coming
  // from commits already on the target branch, so it is only this pull
  // request's business for a component it actually reaches.
  const moved = rows.filter(
    (r): r is MovedRow =>
      r.projected !== undefined && r.projected.version !== r.pending?.version,
  );
  const unmoved = rows.filter(
    (r) =>
      r.projected !== undefined &&
      r.projected.version === r.pending?.version &&
      touched.has(r.pkg.releaseComponent),
  );

  // The table answers "what does merging this cut", so it holds the rows that
  // bear on the merge. The rest are counted once, below.
  const shown = rows.filter(affected);
  const dropped = rows.filter((r) => !affected(r));

  const said = verdict(projection, options, moved, unmoved, touchedPackages);
  const out = ["## Projected releases"];
  if (said) out.push("", said);

  // The table is for reading versions off. With a release on neither side of
  // every row it holds no version to read: the release columns are em dashes
  // top to bottom and the answer is entirely in the line above, which the
  // reader reaches only after checking a table that had nothing in it. The
  // files each package claimed are still listed, under **Matched files**.
  if (shown.some(releasing)) {
    // Columns are decided by every row, not just the shown ones: whether
    // **Path** is worth a column is a fact about the repository, and a
    // heading that comes and goes with the files a pull request happens to
    // touch reads as a different table each time.
    out.push("", ...table(shown, rows, options));
    const line = coverage(dropped, shown.length > 0);
    if (line) out.push("", line);
  }

  const byComponent = groupBy(projection.packages, (p) => p.releaseComponent);
  const shared = new Set(
    [...byComponent].filter(([, list]) => list.length > 1).map(([c]) => c),
  );
  const warnings = warn(projection, options, moved, {
    unmatched,
    shared: byComponent,
    // Only where a release actually had to be attributed. Every package has
    // a row of its own now, so a shared component name is ambiguous only
    // when there is a release to hand to one of them.
    named: new Set(
      rows
        .filter((r) => r.projected ?? r.pending)
        .map((r) => r.pkg.releaseComponent)
        .filter((c) => shared.has(c)),
    ),
  });
  if (warnings.length > 0) out.push("", ...warnings);

  if (moved.length > 0) out.push("", changelog(moved, rows.length > 1));
  out.push("", matchedFiles(projection));
  return out;
}

/** releasing reports whether a row has a version to show in either release
 * column, which is the only reason the table is worth printing. */
function releasing(row: Row): boolean {
  return row.projected !== undefined || row.pending !== undefined;
}

/**
 * buildRows joins the two passes' releases onto the configured packages.
 *
 * Joined on the name release-please attributes releases to, not on the name
 * the config spells: a package that declares no component still gets one, and
 * a package that keeps its component out of its tags gets none.
 *
 * Every release gets a row, including one whose component matches no
 * configured package — that is the one case where a row takes inventing the
 * package, and it is worth the invention: dropping the row instead made the
 * comment report no release for a merge that cuts a tag, which is the false
 * negative this whole action exists to prevent, and it did so in silence.
 */
function buildRows(projection: Projection): {
  rows: Row[];
  unmatched: string[];
} {
  const byComponent = groupBy(projection.packages, (p) => p.releaseComponent);
  const projectedBy = groupBy(projection.projected, (r) => r.component);
  const pendingBy = groupBy(projection.pending, (r) => r.component);

  const claimed = new Map<PackageConfig, Pick<Row, "projected" | "pending">>();
  const unmatched: string[] = [];
  const invented: Row[] = [];

  // Over every component either side names, not just the configured ones: a
  // release whose component matches no package is exactly the case the
  // invented row exists for, and iterating the configuration alone would
  // never reach it.
  const order = claimOrder(byComponent, new Set(projection.touched.keys()));
  const components = new Set([
    ...byComponent.keys(),
    ...projectedBy.keys(),
    ...pendingBy.keys(),
  ]);
  for (const component of components) {
    const packages = order.get(component) ?? [];
    // Each release takes a package of its own. A component name is not
    // unique across packages, and handing the same package to two releases
    // lent one of them the other's current version, path and tag.
    const projected = [...(projectedBy.get(component) ?? [])];
    const pending = [...(pendingBy.get(component) ?? [])];
    for (const pkg of packages) {
      claimed.set(pkg, {
        projected: projected.shift(),
        pending: pending.shift(),
      });
    }
    for (const release of projected) {
      unmatched.push(component);
      invented.push({
        pkg: unconfigured(release, projection),
        projected: release,
        pending: pending.shift(),
        files: [],
      });
    }
  }

  const rows = projection.packages.map((pkg) => ({
    pkg,
    projected: claimed.get(pkg)?.projected,
    pending: claimed.get(pkg)?.pending,
    files: projection.touched.get(pkg.path) ?? [],
  }));
  return { rows: [...rows, ...invented], unmatched };
}

/**
 * table is the comment's work product: one row per package the pull request
 * affects, carrying the numbers rather than a sentence describing the
 * difference between two of them.
 *
 * **Tag** appears only where a tag carries its package's component, which is
 * the case this action exists to show: `include-component-in-tag` and
 * `tag-separator` decide the spelling, neither is anywhere else in the
 * comment, and nothing in **Package** or **Projected** predicts it. Without a
 * component a tag is `v` prefixed to **Projected** and nothing else, so the
 * column would repeat the one beside it for every row — release-please's own
 * spelling, which a reader of this comment knows.
 *
 * **Package** appears only where there is more than one to name. Outside a
 * manifest release-please releases the repository, not a package in it: the
 * name in that column is one release-please derived for itself (a `node`
 * release takes the package.json name), it appears in no tag, and a reader of
 * a single-package repository has no second package to tell it from.
 *
 * **Path** appears only where the rows do not share one. It answers "which of
 * these packages claimed the file", a question a single-package repository
 * does not have: plain mode configures its one package from `release-type:`
 * and gives it the repository root, so the column would be `.` repeated for
 * as many rows as there are, which is one.
 *
 * **Without this PR** is what the target branch releases on its own, which is
 * a weaker claim than "already pending": the release pull request listing is
 * skipped by `link-release-prs: false` and degrades to empty when the call
 * fails, so the cell links a standing pull request only when one was found
 * and otherwise just states the version.
 */
function table(
  rows: readonly Row[],
  all: readonly Row[],
  options: RenderOptions,
): string[] {
  const showPackage = all.length > 1;
  const showPath = new Set(all.map((r) => r.pkg.path)).size > 1;
  // Asked of the tags actually rendered, not of the configuration: a package
  // that would tag with its component but has no projected release spells no
  // tag in this table, and a column of em dashes says nothing at all.
  const showTag = rows.some(
    (r) =>
      r.projected !== undefined &&
      tagFor(r.pkg, r.projected.version) !== `v${r.projected.version}`,
  );
  const columns = [
    ...(showPackage ? ["Package"] : []),
    ...(showPath ? ["Path"] : []),
    "Files",
    "Current",
    "Without this PR",
    "Projected",
    ...(showTag ? ["Tag"] : []),
  ];
  const out = [
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows) {
    const version = row.projected?.version;
    const cells = [
      ...(showPackage ? [code(row.pkg.component)] : []),
      ...(showPath ? [code(row.pkg.path)] : []),
      String(row.files.length || "—"),
      row.pkg.current ?? "—",
      pendingCell(row, options),
      projectedCell(row),
      ...(showTag
        ? [version === undefined ? "—" : `\`${tagFor(row.pkg, version)}\``]
        : []),
    ];
    out.push(`| ${cells.join(" | ")} |`);
  }
  return out;
}

/**
 * affected reports whether a row bears on this pull request at all.
 *
 * Either the pull request changed a file the package claimed, or one of the
 * two passes projects a release for it — which includes a release the merge
 * does not move, since the row is then what says the pull request rides
 * along with it.
 *
 * A package that answers to neither is inventory. Its row was once defended
 * as the evidence that it was considered and came out unchanged, and that is
 * a real thing to say; it is worth one line, not one line per package. On a
 * twenty-package monorepo the defence bought eighteen rows of em dashes
 * around the two that answer the question the comment exists to answer.
 */
function affected(row: Row): boolean {
  return row.files.length > 0 || releasing(row);
}

/** NAMED_UNCHANGED is how many unchanged packages the coverage line will
 * name before it just counts them. Naming them is worth more than the
 * count while the list stays shorter than the rows it replaced. */
const NAMED_UNCHANGED = 3;

/**
 * coverage is the one line accounting for the packages the table drops.
 *
 * It states the same thing their rows did — considered, unchanged — at a
 * length that does not grow with the repository. `others` distinguishes the
 * pull request that moves some packages from the one that moves none, where
 * "other" would be counting against nothing.
 */
function coverage(dropped: readonly Row[], others: boolean): string | undefined {
  if (dropped.length === 0) return undefined;
  const noun = dropped.length === 1 ? "package" : "packages";
  const subject = `${dropped.length}${others ? " other" : ""} ${noun}`;
  const names =
    dropped.length <= NAMED_UNCHANGED
      ? `: ${dropped.map((r) => code(r.pkg.component)).join(", ")}`
      : "";
  return `_${subject} unchanged${names}._`;
}

/** projectedCell is the version merging this pull request leads to, bold only
 * when the merge is what moves it: a version the target branch releases on its
 * own is not this pull request's bump to claim. */
function projectedCell(row: Row): string {
  const version = row.projected?.version;
  if (version === undefined) return "—";
  return version === row.pending?.version ? version : `**${version}**`;
}

/** code spells a cell as inline code, or as an em dash when there is nothing
 * to spell — an unconfigured package has no path, and a package that keeps
 * its component out of its tags may have no name. */
function code(value: string): string {
  return value ? `\`${value}\`` : "—";
}

/**
 * verdict is the line above the table, and there is one only when the table
 * cannot answer on its own.
 *
 * Why nothing releases — a hidden type, a file under no component — is
 * nowhere in a row, so it gets the line. What *does* release is entirely in
 * the row: the version, whether this pull request is what moves it, and the
 * tag. A line repeating any of that is a caption on a photograph of itself,
 * which is what "Cuts `v0.2.0` — minor bump." was.
 */
function verdict(
  projection: Projection,
  options: RenderOptions,
  moved: readonly MovedRow[],
  unmoved: readonly Row[],
  touchedPackages: readonly PackageConfig[],
): string | undefined {
  if (moved.length > 0) return undefined;

  const type = titleType(options.title) ?? "";
  if (unmoved.length > 0) {
    // A visible type still contributes to the release already coming even
    // though it moves no number: its changelog line ships in that version.
    // Saying only that the version does not move reads as contributing
    // nothing, which for a `feat:` is wrong.
    const subject = options.commitMessages
      ? "the branch's commits add"
      : `\`${type}:\` adds`;
    return visibleInput(options)
      ? `No version change — ${subject} only a changelog line.`
      : `No version change — ${subject} nothing to the release already coming.`;
  }
  return none(projection, options, touchedPackages);
}

/**
 * unconfigured invents the package a projected release belongs to when no
 * configured one claims its component.
 *
 * It should not happen: the packages come from the same configuration
 * release-please projected from, and `namePackages` fills in the names it
 * derives. It did happen, twice, from the two ways that join can be read
 * wrongly, and both times the row simply vanished. So the fallback is a row
 * built from what release-please did say, plus a warning naming what is
 * missing, rather than nothing at all.
 *
 * `includeComponent` follows from the component itself: release-please
 * reports a component only for a package that tags with one (`getComponent`
 * is the empty string otherwise), so a named release tags with its name. The
 * separator is the repository's when its packages agree on one, which is the
 * only evidence available.
 */
function unconfigured(release: Release, projection: Projection): PackageConfig {
  const separators = new Set(projection.packages.map((p) => p.separator));
  return {
    path: "",
    component: release.component,
    releaseComponent: release.component,
    current: undefined,
    separator: separators.size === 1 ? [...separators][0]! : "-",
    includeComponent: release.component !== "",
  };
}

/** groupBy indexes values by a key several of them may share. */
function groupBy<T>(
  values: readonly T[],
  key: (value: T) => string,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const value of values) {
    const list = out.get(key(value));
    if (list) list.push(value);
    else out.set(key(value), [value]);
  }
  return out;
}

/**
 * claimOrder copies the packages of each component into the order releases
 * should claim them in: the ones the pull request touches first.
 *
 * It only matters when a component names more than one package, where nothing
 * in release-please's answer says which of them a release belongs to. Having
 * changed a file under one of them is the best evidence available, and the
 * sort is stable, so packages the pull request does not touch keep their
 * configured order behind those it does.
 */
function claimOrder(
  byComponent: ReadonlyMap<string, PackageConfig[]>,
  touchedPaths: ReadonlySet<string>,
): Map<string, PackageConfig[]> {
  const out = new Map<string, PackageConfig[]>();
  for (const [component, list] of byComponent) {
    out.set(
      component,
      [...list].sort(
        (a, b) =>
          Number(touchedPaths.has(b.path)) - Number(touchedPaths.has(a.path)),
      ),
    );
  }
  return out;
}

/**
 * none states which of the two reasons applies. They call for different
 * fixes: one is about the files the branch touches, the other about the type
 * in the title. Which types do release is release-please's documentation to
 * give, and it gave it; the line names the one type in front of the reader.
 *
 * Both statements are scoped to the components this pull request touches,
 * which is what an empty answer actually establishes. A standing release
 * pull request for some other component says nothing about this one, and
 * reading it as "nothing user-facing is pending" contradicts the warning
 * below, which counts every pending release in the repository. The table
 * carries that other component's numbers regardless, so scoping the sentence
 * hides nothing.
 */
function none(
  projection: Projection,
  options: RenderOptions,
  touched: readonly PackageConfig[],
): string {
  if (touched.length === 0) {
    const dirs = [
      ...new Set(projection.files.map((f) => f.split("/")[0] ?? f)),
    ].sort();
    let line = "None — no changed file is under a package path.";
    if (dirs.length > 0) {
      line += ` Touched: ${dirs.map((d) => `\`${d}\``).join(", ")}.`;
    }
    return line;
  }

  const type = titleType(options.title) ?? "";
  // A visible type reaching here is not the ordinary case -- release-please
  // attributes files itself, so it can project nothing for a component this
  // preview counts as touched (a path the package excludes, say). Whatever
  // the cause, the input is not one that releases nothing and must not be
  // reported as one.
  if (visibleInput(options)) {
    return "None — release-please projects no release for the packages touched.";
  }
  return options.commitMessages
    ? "None — no commit on this branch produces a release."
    : `None — \`${type}:\` produces no release.`;
}

/**
 * releasePrUrl finds the standing release pull request holding a component's
 * pending version.
 *
 * The index is keyed by the component in the release branch's name, which is
 * the component release-please knows the package by. Under its *default*
 * `separate-pull-requests: false` there is no such segment: one pull request
 * aggregates every component, on a branch naming none of them, and it indexes
 * under the empty string. Looking a real component up in that index finds
 * nothing, which is how this feature came to cost an API call per run and
 * link nothing at all for the ordinary configuration.
 *
 * The empty key is only read as "the pull request for everything" when it is
 * the whole index. A repository that does separate its release pull requests
 * can have one keyed empty too — a root package that keeps its component out
 * of its branch name — and that one belongs to that package alone.
 */
function releasePrUrl(
  component: string,
  options: RenderOptions,
): string | undefined {
  const prs = options.releasePrs;
  if (!prs || prs.size === 0) return undefined;
  const own = prs.get(component);
  if (own) return own;
  return prs.size === 1 ? prs.get("") : undefined;
}

/** pendingCell is where the component's standing release PR already sits,
 * this pull request excluded, linked to that PR when one is open. */
function pendingCell(row: Row, options: RenderOptions): string {
  if (!row.pending) return "—";
  const url = releasePrUrl(row.pkg.component, options);
  return url ? `[${row.pending.version}](${url})` : row.pending.version;
}

/** warn is the terse list of things that will surprise someone. */
function warn(
  projection: Projection,
  options: RenderOptions,
  moved: readonly MovedRow[],
  components: {
    unmatched: readonly string[];
    shared: ReadonlyMap<string, PackageConfig[]>;
    named: ReadonlySet<string>;
  },
): string[] {
  const warnings: string[] = [...(options.advisories ?? [])];
  // Why a version came out as it did is otherwise the commit type, which is
  // in the title just above. A note that overrode it is not.
  const asked = projection.releaseAs;
  if (asked && !projection.ignoredReleaseAs && moved.some((r) => r.projected.version === asked)) {
    warnings.push(`- \`Release-As: ${asked}\` forces the version.`);
  }
  // The row is shown from release-please's answer alone, so the reader is
  // told which parts of it this comment could not fill in.
  for (const component of [...new Set(components.unmatched)].sort()) {
    warnings.push(
      `- release-please releases ${component ? `\`${component}\`` : "a package this comment cannot name"},` +
        " which matches no configured package here. The row's **Current**" +
        " and matched files are unknown, and its tag is this comment's" +
        " reading rather than a configured one.",
    );
  }
  // Nothing in release-please's answer says which of two packages sharing a
  // component name a release belongs to, so a row that could be either says
  // so rather than presenting a guess as the working.
  for (const component of [...components.named].sort()) {
    const paths = (components.shared.get(component) ?? [])
      .map((p) => `\`${p.path}\``)
      .join(", ");
    warnings.push(
      `- ${paths} release under one component name, so a row's` +
        " **Current** and matched files may belong to either. Give each" +
        " package its own `component`.",
    );
  }
  // Ahead of the Release-As note, because it is the one warning that says the
  // numbers in the table may be wrong rather than explaining why they are
  // what they are.
  for (const found of projection.unresolved) {
    const name = found.component ? `\`${found.component}\`` : `\`${found.path}\``;
    const where =
      found.on === "both"
        ? ""
        : found.on === "base"
          ? " on the target branch"
          : " on this branch";
    warnings.push(
      `- ${name} has no release or tag at its manifest version` +
        ` \`${found.version}\`${where}, so release-please had no boundary and` +
        " replayed the component's whole history. **Any version shown for it" +
        " above may be wrong.** A component being released for the first time" +
        " looks like this too.",
    );
  }
  if (projection.ignoredReleaseAs) {
    // Which explanation is the right one follows the same fact the rest of
    // the comment follows: whether the title and description are what
    // release-please parses. Under a merge or a rebase the description
    // reaches a commit message only where the merge commit is configured to
    // carry it, so "check the merge box" would send the reader to a box that
    // does not decide it.
    const why = options.commitMessages
      ? " release-please returned a different version. This repository does" +
        " not squash, so the description is not a commit message: it reaches" +
        " release-please only where the merge commit is configured to carry" +
        " it, and a merge subject that is not a Conventional Commit voids the" +
        " whole message anyway. Put the note in a commit on the branch, at" +
        " the end of its message, where it parses as a git trailer."
      : " release-please returned a different version. A note only counts" +
        " when it parses as a git trailer, so no non-trailer text may follow" +
        " it: a `---` rule or an attribution line below it voids it silently." +
        " Check the merge box too, which is prefilled from the description" +
        " but editable.";
    warnings.push(`- \`Release-As: ${projection.ignoredReleaseAs}\` was **ignored** —${why}`);
  }
  return warnings;
}

/** changelog shows the notes release-please rendered, which are the release
 * notes the tag will actually carry. Secondary to the numbers, so collapsed.
 * `named` follows the table's **Package** column: with one package there is
 * nothing to tell these notes apart from. */
function changelog(moved: readonly MovedRow[], named: boolean): string {
  const body = moved
    .filter((r) => r.projected.notes)
    .map((r) =>
      named
        ? `#### ${code(r.pkg.component)}\n\n${r.projected.notes}`
        : r.projected.notes,
    )
    .join("\n\n");
  return [
    "<details><summary>Changelog preview</summary>",
    "",
    body || "_release-please rendered no notes._",
    "",
    "</details>",
  ].join("\n");
}

/**
 * matchedFiles is the working behind the table's file counts: which file
 * pulled in which package, so a surprising count can be traced to its
 * cause. Collapsed, because the count is the part that is read.
 */
function matchedFiles(projection: Projection): string {
  const named = projection.packages.length > 1;
  const lines = ["<details><summary>Matched files</summary>", ""];
  for (const [path, files] of projection.touched) {
    const pkg = projection.packages.find((p) => p.path === path);
    const shown = files.slice(0, 10);
    if (named) lines.push(`\`${pkg?.component ?? path}\` matched:`);
    for (const file of shown) lines.push(`- \`${file}\``);
    if (files.length > shown.length) {
      lines.push(`- …and ${files.length - shown.length} more`);
    }
    lines.push("");
  }
  // Which of the two rules applies depends on whether a package is rooted at
  // the repository. `splitFiles` hands a root package every file, so printing
  // "a repository-root file belongs to none" there contradicted the very
  // listing above it -- as it did on every comment this action posted on its
  // own repository, which releases in plain mode from `.`.
  const rooted = projection.packages.some((p) => p.path === ROOT_PACKAGE_PATH);
  // One package rooted at the repository takes every file there is, so there
  // was no attribution to explain: the rule would describe a choice the
  // repository never makes, on the listing of a plain-mode repository where
  // it is the only thing under the heading.
  if (named || !rooted) {
    lines.push(
      rooted
        ? "A file belongs to the package with the longest matching path;" +
          ` \`${ROOT_PACKAGE_PATH}\` takes every file besides.`
        : "A file belongs to the package with the longest matching path; a" +
          " repository-root file belongs to none.",
      "",
    );
  }
  lines.push("</details>");
  return lines.join("\n");
}
