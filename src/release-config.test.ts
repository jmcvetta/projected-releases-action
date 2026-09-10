/**
 * This repository's own release configuration, which two files and two
 * workflows have to agree about.
 *
 * release-please is configured here in manifest mode, and the switch that
 * selects it is an *absence*: `release-type:` on release-please-action makes
 * the action build its configuration from its inputs and read neither
 * release-please-config.json nor .release-please-manifest.json. So the input
 * left off the release workflow is load-bearing, and so is the one left off
 * the dogfood step in projected-releases.yml -- which projects the release the
 * other one will cut, and would project a different configuration if it named
 * a mode of its own.
 *
 * Every way this can go wrong is quiet. A `release-type:` added to either
 * workflow releases and projects from a configuration nobody wrote down; a
 * package that drops `include-component-in-tag: false` starts tagging
 * `projected-releases-action-v0.8.0`, which matches none of v0.1.0 .. v0.7.1
 * and so loses the release boundary; and a manifest version that stops
 * matching package.json is a base version somebody edited by hand.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const url = (path: string) => new URL(path, import.meta.url);
const json = (path: string) => JSON.parse(readFileSync(url(path), "utf8"));

/** Step is as much of a workflow step as this file reads. */
interface Step {
  uses?: string;
  with?: Record<string, unknown>;
}

/** Workflow is as much of a workflow file as this file reads. */
interface Workflow {
  jobs: Record<string, { steps: Step[] }>;
}

/** workflow reads one of this repository's workflows. */
const workflow = (name: string) =>
  parse(readFileSync(url(`../.github/workflows/${name}`), "utf8")) as Workflow;

/** steps are every step of every job in a workflow, flattened: which job a
 * step sits in decides nothing here. */
const steps = (file: Workflow) =>
  Object.values(file.jobs).flatMap((job) => job.steps);

const pkg = json("../package.json") as { version: string };
const config = json("../release-please-config.json") as {
  "bump-minor-pre-major"?: boolean;
  packages: Record<string, Record<string, unknown>>;
};
const manifest = json("../.release-please-manifest.json") as Record<string, string>;

describe("release-please-config.json", () => {
  it("bumps a minor rather than a major below 1.0.0", () => {
    // The reason this repository is in manifest mode at all. Without it a
    // `feat!:` cuts 1.0.0, which asserts a stable interface to everyone
    // pinning `@v0`; with it, 1.0.0 takes a `Release-As:` trailer, which is
    // somebody deciding.
    expect(config["bump-minor-pre-major"]).toBe(true);
  });

  it("declares the one package this repository is", () => {
    expect(Object.keys(config.packages)).toEqual(["."]);
    expect(config.packages["."]?.["release-type"]).toBe("node");
  });

  it("keeps the component out of the tags", () => {
    // A manifest package defaults this to true and plain mode defaults it to
    // false, so this is the line that survived the move. Every tag from
    // v0.1.0 on carries no component, and release-please matches a release to
    // a package by that shape.
    expect(config.packages["."]?.["include-component-in-tag"]).toBe(false);
  });
});

describe(".release-please-manifest.json", () => {
  it("names the same paths the config does", () => {
    expect(Object.keys(manifest)).toEqual(Object.keys(config.packages));
  });

  it("holds the version package.json holds", () => {
    // release-please writes both in the same release pull request, so they
    // part company only when someone edits one by hand -- and the manifest is
    // the base the next bump applies to, never the next version.
    expect(manifest["."]).toBe(pkg.version);
  });
});

describe("the workflows that name the release mode", () => {
  it("releases without a `release-type` input", () => {
    const release = steps(workflow("release-please.yml")).filter((step) =>
      step.uses?.startsWith("googleapis/release-please-action"),
    );
    // Exactly one, or the assertion below is about a step that is not the
    // releaser -- or about no step at all.
    expect(release).toHaveLength(1);
    expect(release[0]?.with ?? {}).not.toHaveProperty("release-type");
  });

  it("projects without one either", () => {
    const dogfood = steps(workflow("projected-releases.yml")).filter(
      (step) => step.uses === "./",
    );
    expect(dogfood).toHaveLength(1);
    expect(dogfood[0]?.with ?? {}).not.toHaveProperty("release-type");
  });
});
