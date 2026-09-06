/**
 * workflow compares the configuration this action was given against the one
 * the repository's release workflow passes release-please.
 *
 * In release-please's non-manifest mode there is no configuration file: the
 * values live on `release-please-action`, in a `with:` block, and projecting
 * that repository means writing the same values a second time on this action.
 * Two copies of one configuration, under the same names, and nothing compares
 * them — so a repository that changes `versioning-strategy` in its release
 * workflow and not here keeps getting a projection of tags it will not cut.
 * A confidently wrong answer is the failure this action exists to prevent
 * elsewhere.
 *
 * The values are in the repository, in whichever workflow calls
 * `release-please-action`, so they can be read and checked. **Checked, not
 * used.** Reading the workflow to *replace* what the caller typed would put
 * every one of this parser's failure modes — the wrong workflow, the wrong
 * job, an unresolved `${{ }}`, more than one caller — into the number on the
 * comment, which is the one thing that has to be trustworthy. Reading it only
 * to check fails the other way: anything this cannot work out with certainty
 * produces no note, which is exactly the behaviour before it existed.
 *
 * So every uncertainty here is spelled `return`:
 *
 * - no `.github/workflows`, or nothing in it calling `release-please-action`;
 * - a workflow that does not parse as YAML;
 * - two callers that could both govern this branch;
 * - a value written as an expression, which only the runner can resolve.
 *
 * What it reads is the head branch's copy of the workflow, since that is the
 * one the merge leaves behind — a pull request that changes the release
 * workflow is checked against its own change.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import {
  DEFAULT_CONFIG_FILE,
  DEFAULT_MANIFEST_FILE,
  PLAIN_INCLUDE_COMPONENT_IN_TAG,
} from "./project.js";
import type { PlainConfig } from "./project.js";

/** WORKFLOW_DIR is where GitHub reads workflows from, in the checkout. */
export const WORKFLOW_DIR = ".github/workflows";

/** OFF is the `release-workflow` value that reads nothing. */
export const OFF = "off";

/** AUTO is the `release-workflow` value that scans WORKFLOW_DIR. */
export const AUTO = "auto";

/**
 * ACTION matches a `uses:` naming release-please-action.
 *
 * Any owner, because a repository may run a fork of it, and with or without a
 * ref, because it may be pinned to a tag or a sha. What is not matched is a
 * reusable *workflow* in another repository, which the checkout does not
 * hold: that caller is silence, like the rest of what cannot be read.
 */
const ACTION = /^[\w.-]+\/release-please-action(?:\/[^@\s]*)?(?:@\S*)?$/;

/** EXPRESSION is a value only the runner can resolve. */
const EXPRESSION = /\$\{\{/;

/** Caller is one step handing this repository to release-please-action. */
export interface Caller {
  /** file is the workflow's path as the checkout names it, for the note. */
  file: string;
  /** given are the `with:` values that resolved to a literal, by input name.
   * A key absent from it is unset or unresolved, which are different things
   * and are told apart by `unresolved`. */
  given: Map<string, string>;
  /** unresolved are the `with:` keys written as `${{ }}`. A key here is set
   * to something, and what it is set to is not knowable from the file. */
  unresolved: Set<string>;
}

/** Comparison is what reading the release workflow produced. */
export interface Comparison {
  /**
   * decided reports that one governing caller was found and compared.
   *
   * It is the answer to the mode question, which nothing else in this
   * repository can answer: `release-type`'s presence is the mode switch, and
   * until now the only thing available was to notice that the checkout
   * contradicted the mode chosen and say that one of the two was wrong. When
   * this is true, that guess is no longer needed — including when the
   * comparison found nothing to say, which is itself the answer that the two
   * agree.
   */
  decided: boolean;
  /** notes are the advisories, in the comment's bullet form. */
  notes: string[];
}

/** Given is the configuration this action was told to project. */
export interface Given {
  /** plain is the non-manifest configuration, or undefined for a repository
   * whose configuration is in files. */
  plain?: PlainConfig | undefined;
  /** configFile and manifestFile are the paths manifest mode reads. */
  configFile: string;
  manifestFile: string;
  /** base is the branch the pull request targets, which is the branch a
   * caller has to be releasing for its inputs to be the ones that apply. */
  base: string;
  /** root is the checkout, which is where `.github/workflows` is looked for. */
  root: string;
  /** workflow is `auto` (scan), `off` (read nothing), or one workflow's
   * path. */
  workflow?: string | undefined;
}

/**
 * compareReleaseWorkflow reads the release workflow and reports where it
 * disagrees with what this action was given.
 *
 * An explicitly named workflow that is not there is the one error: the caller
 * asked for that file, and silently reading nothing would leave them with a
 * comparison they think is happening and is not.
 */
export function compareReleaseWorkflow(given: Given): Comparison {
  const setting = (given.workflow ?? AUTO).trim() || AUTO;
  // The two keywords are matched case-insensitively, as `include-component
  // -in-tag` and the rest of this action's enumerated inputs are: `Off` is
  // plainly someone turning the check off, and the alternative is not a
  // stricter reading but a worse one, since anything that is not a keyword
  // is a path and a missing path throws. The path itself keeps its case,
  // which a filesystem may well care about.
  const keyword = setting.toLowerCase();
  if (keyword === OFF) return { decided: false, notes: [] };

  const files =
    keyword === AUTO ? workflowFiles(given.root) : [namedWorkflow(given.root, setting)];
  const callers = files.flatMap((file) => callersIn(given.root, file));
  const caller = governing(callers, given.base);
  // An expression where `release-type` goes is the mode itself left to the
  // runner, and the mode decides which values are even worth comparing. That
  // is the one unresolved value that stops the whole comparison rather than
  // one line of it.
  if (!caller || caller.unresolved.has("release-type")) {
    return { decided: false, notes: [] };
  }
  return { decided: true, notes: notes(caller, given) };
}

/**
 * governing picks the one caller whose inputs describe this branch's
 * releases, or nothing.
 *
 * `target-branch` is what tells two callers apart — a repository releasing
 * from `master` and from a `v1.x` maintenance branch has one step for each —
 * and a step that does not set it releases from the default branch, which is
 * the branch this projection is about in every ordinary case. Anything left
 * over after that filter is a repository whose release configuration this
 * cannot identify, and identifying it wrongly would compare a pull request
 * against a configuration that has nothing to do with it.
 *
 * A `target-branch` written as an expression is not the same as one left
 * unset, and reading it as one would take the maintenance-branch step for the
 * step releasing `master`. It could name any branch, so it counts as a
 * candidate — which is enough to make a second caller ambiguous — and being
 * the only candidate does not make it the right one either.
 */
export function governing(
  callers: readonly Caller[],
  base: string,
): Caller | undefined {
  const plausible = callers.filter((caller) => {
    if (caller.unresolved.has("target-branch")) return true;
    const target = caller.given.get("target-branch");
    return target === undefined || target === "" || target === base;
  });
  if (plausible.length !== 1) return undefined;
  const only = plausible[0];
  return only?.unresolved.has("target-branch") ? undefined : only;
}

/** workflowFiles lists the workflows in the checkout, or nothing when there
 * is no checkout to list — which is the ordinary state of a run that checked
 * nothing out. */
function workflowFiles(root: string): string[] {
  const dir = resolve(root, WORKFLOW_DIR);
  try {
    if (!statSync(dir).isDirectory()) return [];
    return readdirSync(dir)
      .filter((name) => /\.ya?ml$/.test(name))
      .sort()
      .map((name) => `${WORKFLOW_DIR}/${name}`);
  } catch {
    return [];
  }
}

/** namedWorkflow resolves the `release-workflow` path a caller gave. */
function namedWorkflow(root: string, path: string): string {
  if (existsSync(resolve(root, path))) return path;
  throw new Error(
    `no \`${path}\` in \`${root}\`: \`release-workflow\` names the workflow` +
      " that calls release-please-action, so that this action's inputs can be" +
      " compared with the ones it passes. Set it to `auto` to go looking for" +
      " that workflow, or `off` to compare nothing.",
  );
}

/**
 * callersIn reads one workflow and returns the release-please-action steps in
 * it.
 *
 * Every failure is empty: a file that has gone missing between the listing
 * and the read, one that is not YAML, one whose `jobs:` is something else
 * entirely. A workflow this cannot read is a workflow GitHub may well run,
 * and saying nothing about it is the honest answer.
 */
export function callersIn(root: string, file: string): Caller[] {
  let document: unknown;
  try {
    document = parse(readFileSync(resolve(root, file), "utf8"));
  } catch {
    return [];
  }

  const jobs = record(record(document)?.["jobs"]);
  if (!jobs) return [];

  const callers: Caller[] = [];
  for (const job of Object.values(jobs)) {
    const steps = record(job)?.["steps"];
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      const uses = record(step)?.["uses"];
      if (typeof uses !== "string" || !ACTION.test(uses.trim())) continue;
      callers.push({ file, ...inputsOf(record(step)?.["with"]) });
    }
  }
  return callers;
}

/** inputsOf splits a `with:` block into what resolved and what did not. */
function inputsOf(block: unknown): { given: Map<string, string>; unresolved: Set<string> } {
  const given = new Map<string, string>();
  const unresolved = new Set<string>();
  for (const [name, value] of Object.entries(record(block) ?? {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === "object") continue;
    const text = String(value).trim();
    if (EXPRESSION.test(text)) unresolved.add(name);
    else given.set(name, text);
  }
  return { given, unresolved };
}

/** record narrows a parsed YAML node to a plain object, or undefined. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Setting is one value both actions have an input for, and the rule for
 * reading it off each side.
 *
 * `unset` is what release-please does when neither side says, and it is the
 * reason a comparison can be made at all: the two actions have to agree on
 * the *effective* value, not on which of them typed it. Both default
 * `include-component-in-tag` to false, both default `versioning-strategy` to
 * `default`, and both treat an empty `path` as the repository root — so an
 * input set on one side and left alone on the other is a difference only when
 * the value set is not the default. Measured against release-please-action's
 * own action.yml rather than assumed.
 */
interface Setting {
  /** ours is the input's name on this action. */
  ours: string;
  /** theirs is its name on release-please-action, where it differs. */
  theirs?: string;
  /** unset is the effective value when neither side declares one. */
  unset: string;
  /** read normalizes a declared value into a comparable one. */
  read?: (value: string) => string;
}

/** PLAIN are the settings that decide what a non-manifest release cuts. */
const PLAIN: readonly Setting[] = [
  { ours: "package-path", theirs: "path", unset: ".", read: directory },
  {
    ours: "include-component-in-tag",
    unset: String(PLAIN_INCLUDE_COMPONENT_IN_TAG),
    read: (value) => value.toLowerCase(),
  },
  { ours: "versioning-strategy", unset: "default" },
  { ours: "release-as", unset: "" },
];

/** directory normalizes the ways of writing the repository root. */
function directory(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed === "" || trimmed === "." ? "." : trimmed;
}

/** UNSHARED are this action's plain-mode inputs release-please-action has no
 * input for at all, so a repository it releases cannot be passing them. */
const UNSHARED = ["component", "tag-separator"] as const;

/** notes lists everything the caller and this action disagree about. */
function notes(caller: Caller, given: Given): string[] {
  const mode = modeNote(caller, given);
  if (mode) return [mode];
  // Past here the two agree on which mode the release runs in, so the values
  // that mode reads are worth comparing. The other mode's are not: a
  // `config-file` passed alongside a `release-type` names a file release
  // -please never opens.
  return given.plain ? plainNotes(caller, given.plain) : manifestNotes(caller, given);
}

/**
 * modeNote reports the two sides selecting different modes, which is the
 * disagreement that makes every other one moot.
 *
 * `release-type`'s presence is the whole of the switch, on both actions. Set
 * on one and not the other, the two runs read different configurations
 * entirely, and comparing their `versioning-strategy` would be answering a
 * question neither side is asking.
 */
function modeNote(caller: Caller, given: Given): string | undefined {
  const theirs = caller.given.get("release-type") ?? "";
  const plainThere = theirs !== "";
  const plainHere = given.plain !== undefined;
  if (plainThere === plainHere) return undefined;

  if (plainThere) {
    return (
      `- \`${caller.file}\` passes release-please \`release-type: ${theirs}\`, which is` +
      " the switch into its non-manifest mode: the release will not read" +
      ` \`${given.configFile}\`, and this projection did. Pass this action the` +
      " same `release-type` — and the rest of that step's `with:` block — to" +
      " model the release that will run."
    );
  }
  return (
    "- `release-type` is set here, so this projection is release-please's" +
    ` non-manifest mode — but \`${caller.file}\` calls release-please-action` +
    ` without one, so the release reads \`${given.configFile}\` instead.` +
    " Clearing `release-type` here reads the same files it will."
  );
}

/** plainNotes compares the values a non-manifest release is configured by. */
function plainNotes(caller: Caller, plain: PlainConfig): string[] {
  const ours = new Map<string, string>([
    ["release-type", plain.releaseType],
    ...(plain.path !== undefined ? [["package-path", plain.path] as const] : []),
    ...(plain.includeComponentInTag !== undefined
      ? [["include-component-in-tag", String(plain.includeComponentInTag)] as const]
      : []),
    ...(plain.versioning !== undefined
      ? [["versioning-strategy", plain.versioning] as const]
      : []),
    ...(plain.releaseAs !== undefined ? [["release-as", plain.releaseAs] as const] : []),
  ]);

  const found = [
    { ours: "release-type", unset: "" } as Setting,
    ...PLAIN,
  ].flatMap((setting) => {
    const note = drift(caller, setting, ours.get(setting.ours));
    return note ? [note] : [];
  });

  for (const name of UNSHARED) {
    const value = name === "component" ? plain.component : plain.tagSeparator;
    if (!value) continue;
    found.push(
      `- \`${name}\` is set here, and release-please-action has no input for` +
        ` it: \`${caller.file}\` cannot pass one, so the release takes what` +
        " release-please derives. The projection models" +
        ` \`${value}\` instead. Leave it unset unless something other than` +
        " that workflow cuts this repository's releases.",
    );
  }
  return found;
}

/** manifestNotes compares the two file paths a manifest release reads, which
 * are the whole of what a manifest-mode caller can disagree about. */
function manifestNotes(caller: Caller, given: Given): string[] {
  // The unset side is release-please-action's default rather than this
  // action's: a workflow that names no config file reads
  // `release-please-config.json`, whatever this action was pointed at.
  const settings: readonly Setting[] = [
    { ours: "config-file", unset: DEFAULT_CONFIG_FILE },
    { ours: "manifest-file", unset: DEFAULT_MANIFEST_FILE },
  ];
  const ours = new Map<string, string>([
    ["config-file", given.configFile],
    ["manifest-file", given.manifestFile],
  ]);
  return settings.flatMap((setting) => {
    const note = drift(caller, setting, ours.get(setting.ours));
    return note ? [note] : [];
  });
}

/**
 * drift compares one setting and renders the note when the two differ.
 *
 * A value the workflow leaves to an expression is not compared: the runner
 * resolves it from a variable, a matrix or an output, and none of those is in
 * the file. Guessing there would produce a note on every run of a repository
 * that is doing nothing wrong, which is worse than the silence it replaced.
 */
function drift(
  caller: Caller,
  setting: Setting,
  mine: string | undefined,
): string | undefined {
  const name = setting.theirs ?? setting.ours;
  if (caller.unresolved.has(name)) return undefined;

  const read = setting.read ?? ((value: string) => value);
  const raw = caller.given.get(name);
  const theirs = raw === undefined || raw === "" ? setting.unset : read(raw);
  const ours = mine === undefined || mine === "" ? setting.unset : read(mine);
  if (theirs === ours) return undefined;

  return (
    `- \`${caller.file}\` passes release-please ${shown(raw, name, setting)},` +
    ` and this action was given ${shown(mine, setting.ours, setting)}. The` +
    " projection models the second; the release will use the first."
  );
}

/**
 * shown renders one side's value, under the name that side writes it by.
 *
 * The two names differ for `path`, which this action calls `package-path`,
 * and a note that used one name for both would send the reader to change the
 * wrong file.
 */
function shown(
  value: string | undefined,
  name: string,
  setting: Setting,
): string {
  if (value === undefined || value === "") {
    return setting.unset === ""
      ? `no \`${name}\``
      : `no \`${name}\`, so \`${setting.unset}\``;
  }
  return `\`${name}: ${value}\``;
}
