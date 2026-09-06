/**
 * main is the command line entry point: render the projected-releases comment
 * for one pull request and write it to a file or standard output.
 *
 * It exists so the tool can be driven by hand from a checkout, which is how a
 * projection gets compared against the merge that follows it, and how a
 * change to the rendering is reviewed without pushing a pull request to look
 * at. The action entry point (src/action.ts) reads the same options from the
 * runner instead.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { changedFiles } from "./git.js";
import { plainConfig } from "./plain.js";
import { DEFAULT_CONFIG_FILE, DEFAULT_MANIFEST_FILE } from "./project.js";
import { loadReleasePrs } from "./release-prs.js";
import { buildComment, quietLogger } from "./run.js";
import { AUTO } from "./workflow.js";

/**
 * cli renders one projection from command line flags. Exported rather than
 * run on import so the single bundled entry point can dispatch to it.
 */
export async function cli(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      title: { type: "string" },
      "body-file": { type: "string" },
      repo: { type: "string" },
      // The branch release-please reads, by name. The local ref the changed
      // -file diff runs against is separate (`--diff-base`), because the two
      // are not the same string: release-please wants `master`, git wants
      // `origin/master`.
      base: { type: "string", default: "main" },
      "diff-base": { type: "string", default: "" },
      head: { type: "string", default: "HEAD" },
      "head-sha": { type: "string", default: "" },
      "head-branch": { type: "string", default: "" },
      number: { type: "string", default: "0" },
      token: { type: "string", default: process.env["GITHUB_TOKEN"] ?? "" },
      "repo-root": { type: "string", default: "." },
      "config-file": { type: "string", default: DEFAULT_CONFIG_FILE },
      "manifest-file": { type: "string", default: DEFAULT_MANIFEST_FILE },
      // The release workflow this repository's plain-mode inputs are a second
      // copy of: `auto` finds it, `off` reads nothing, a path names it.
      "release-workflow": { type: "string", default: AUTO },
      "release-prs": { type: "string" },
      "release-branch-prefix": { type: "string" },
      // Plain mode: one package, configured here, no config or manifest file
      // in the checkout. Mirrors the action inputs of the same names.
      "release-type": { type: "string" },
      "package-path": { type: "string" },
      component: { type: "string" },
      // A string, not a boolean: `parseArgs` reads a boolean option as set or
      // unset and drops `=false` on the floor, so a boolean here could ask
      // for the component in the tag but never ask for it to be left out --
      // which is the half that differs from release-please's own default.
      "include-component-in-tag": { type: "string" },
      "tag-separator": { type: "string" },
      // Reach release-please only in this mode, exactly as on
      // release-please-action, which passes them to `Manifest.fromConfig`
      // and to nothing else.
      "versioning-strategy": { type: "string" },
      "release-as": { type: "string" },
      // The changed-file list, supplied rather than diffed. For driving the
      // tool where there is no checkout to diff -- a test, or a projection
      // reconstructed after the fact from a merge's file list.
      files: { type: "string" },
      "visible-types": { type: "string" },
      "hidden-types": { type: "string" },
      "api-url": { type: "string" },
      "graphql-url": { type: "string" },
      "run-url": { type: "string", default: "" },
      out: { type: "string" },
    },
  });

  const title = values.title;
  if (!title) throw new Error("--title is required");
  const repo = values.repo;
  if (!repo || !repo.includes("/")) {
    throw new Error("--repo is required, as owner/name");
  }
  const [owner = "", name = ""] = repo.split("/");

  quietLogger();

  const base = values.base;
  const list = (value: string | undefined) =>
    value ? value.split(/[\s,]+/).filter(Boolean) : undefined;
  const visible = list(values["visible-types"]);
  const hidden = list(values["hidden-types"]);

  const plain = plainConfig(
    (name) => values[name as keyof typeof values] as string | undefined,
    (name) => `--${name}`,
  );

  const outcome = await buildComment({
    owner,
    repo: name,
    token: values.token,
    title,
    body: values["body-file"] ? readFileSync(values["body-file"], "utf8") : "",
    number: Number(values.number) || 0,
    base,
    headSha: values["head-sha"],
    headBranch: values["head-branch"],
    files:
      list(values.files) ??
      changedFiles(values["diff-base"] || `origin/${base}`, values.head),
    repoRoot: values["repo-root"],
    baseRef: values["diff-base"] || `origin/${base}`,
    configFile: values["config-file"],
    manifestFile: values["manifest-file"],
    releaseWorkflow: values["release-workflow"],
    releasePrs: values["release-prs"]
      ? loadReleasePrs(
          readFileSync(values["release-prs"], "utf8"),
          values["release-branch-prefix"],
          base,
        )
      : new Map<string, string>(),
    runUrl: values["run-url"],
    ...(visible || hidden
      ? { typeOverrides: { ...(visible ? { visible } : {}), ...(hidden ? { hidden } : {}) } }
      : {}),
    ...(values["release-branch-prefix"]
      ? { releaseBranchPrefix: values["release-branch-prefix"] }
      : {}),
    ...(plain ? { plain } : {}),
    ...(values["api-url"] ? { apiUrl: values["api-url"] } : {}),
    ...(values["graphql-url"] ? { graphqlUrl: values["graphql-url"] } : {}),
  });

  if (values.out) writeFileSync(values.out, outcome.body);
  else process.stdout.write(outcome.body);
}
