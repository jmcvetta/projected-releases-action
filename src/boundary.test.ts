/**
 * These tests drive real release-please against a repository whose manifest
 * and tags disagree.
 *
 * The end-to-end cases are the point of the file. `boundary.ts` reads a line
 * release-please logs, which is a seam: the wording is not part of any public
 * contract and an upgrade could move it, at which point the warning would
 * simply stop appearing — a check that quietly stops checking, which is the
 * failure this warning exists to prevent, arriving by the back door. Nothing
 * short of running release-please detects that, so these tests run it.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  armBoundaryWatch,
  drainBoundaries,
  parseUnresolvedBoundary,
  watchBoundaries,
} from "./boundary.js";
import { fakeScm, RELEASE_SHA } from "./fake-scm.fixture.js";
import { mergeUnresolved, project } from "./project.js";
import { render } from "./render.js";

const QUIET = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  trace: () => {},
};

const CONFIG = {
  "separate-pull-requests": true,
  packages: {
    api: {
      "release-type": "simple",
      component: "acme-api",
      "include-component-in-tag": true,
      "tag-separator": "@",
    },
    ui: {
      "release-type": "simple",
      component: "acme-ui",
      "include-component-in-tag": true,
      "tag-separator": "@",
    },
  },
};
const MANIFEST = { api: "2.4.1", ui: "1.0.0" };

/** RESOLVED is the release list a healthy repository has: one per manifest
 * entry, at the version the manifest names. */
const RESOLVED = [
  { tagName: "acme-api@v2.4.1", sha: RELEASE_SHA },
  { tagName: "acme-ui@v1.0.0", sha: RELEASE_SHA },
];

/**
 * project one pull request against a repository whose releases are given.
 *
 * `manifest` is the pull request's copy, `baseManifest` the target branch's;
 * they differ while a pull request is repairing one.
 */
async function run(options: {
  releases: { tagName: string; sha: string }[];
  manifest?: Record<string, string>;
  baseManifest?: Record<string, string>;
}) {
  const manifest = options.manifest ?? MANIFEST;
  const baseManifest = options.baseManifest ?? manifest;
  return project({
    // release-please reads the manifest from the target branch, so the fake
    // serves the base's copy; `project` overrides it with the head's for the
    // pass that has the pull request in it, where the pull request changes
    // it -- so a pull request carrying its own copy lists the file.
    github: fakeScm({
      config: CONFIG,
      manifest: baseManifest,
      releases: options.releases,
      commits: [
        { sha: "feed01", message: "feat: a thing", files: ["api/src/x.ts"] },
      ],
    }),
    config: CONFIG,
    manifest,
    commit: {
      title: "fix: another thing",
      body: "",
      files: options.manifest
        ? ["api/src/x.ts", ".release-please-manifest.json"]
        : ["api/src/x.ts"],
      number: 7,
      headSha: "abcdef1234567890",
      headBranch: "topic",
      baseBranch: "master",
    },
  });
}

beforeEach(() => {
  watchBoundaries(QUIET);
});

describe("parseUnresolvedBoundary", () => {
  it("reads path, component and version out of the line", () => {
    expect(
      parseUnresolvedBoundary(
        "No latest release found for path: viewer, component: viewer," +
          " but a previous version (0.2.1) was specified in the manifest.",
      ),
    ).toEqual({ path: "viewer", component: "viewer", version: "0.2.1" });
  });

  it("reads a package that keeps its component out of its tags", () => {
    expect(
      parseUnresolvedBoundary(
        "No latest release found for path: ., component: , but a previous" +
          " version (1.2.3) was specified in the manifest.",
      ),
    ).toEqual({ path: ".", component: "", version: "1.2.3" });
  });

  it("ignores every other line release-please logs", () => {
    for (const line of [
      "Splitting 418 commits by path",
      "Expected 4 releases, only found 3",
      "Missing 1 paths: viewer",
      "No latest release pull request found.",
    ]) {
      expect(parseUnresolvedBoundary(line)).toBeUndefined();
    }
  });
});

describe("watchBoundaries", () => {
  it("passes the line on to the sink as well as recording it", async () => {
    const info: string[] = [];
    watchBoundaries({
      ...QUIET,
      info: (message: unknown) => {
        if (typeof message === "string") info.push(message);
      },
    } as Parameters<typeof watchBoundaries>[0]);

    const projection = await run({
      releases: [{ tagName: "acme-api@v2.4.1", sha: RELEASE_SHA }],
    });

    // Recorded...
    expect(projection.unresolved.map((u) => u.component)).toEqual(["acme-ui"]);
    // ...and still delivered, so watching does not swallow release-please's
    // own logging.
    expect(
      info.filter((line) => line.startsWith("No latest release found for path")),
    ).toHaveLength(2);
  });
});

describe("an unresolved boundary, through real release-please", () => {
  it("is not reported when every manifest entry has a release", async () => {
    const projection = await run({ releases: RESOLVED });
    expect(projection.unresolved).toEqual([]);
  });

  it("is reported on both sides when the repository has lost a tag", async () => {
    // acme-ui's manifest entry names 1.0.0 and no release or tag says so,
    // which is what a release run that wrote the manifest and never cut the
    // tag leaves behind.
    const projection = await run({
      releases: [{ tagName: "acme-api@v2.4.1", sha: RELEASE_SHA }],
    });
    expect(projection.unresolved).toEqual([
      { path: "ui", component: "acme-ui", version: "1.0.0", on: "both" },
    ]);
  });

  it("is reported against the target branch alone when the pull request repairs it", async () => {
    // The pull request reverts the manifest to the version that was really
    // released, so its own pass resolves and the target branch's does not.
    const projection = await run({
      releases: [
        { tagName: "acme-api@v2.4.1", sha: RELEASE_SHA },
        { tagName: "acme-ui@v1.0.0", sha: RELEASE_SHA },
      ],
      manifest: { api: "2.4.1", ui: "1.0.0" },
      baseManifest: { api: "2.4.1", ui: "9.9.9" },
    });
    expect(projection.unresolved).toEqual([
      { path: "ui", component: "acme-ui", version: "9.9.9", on: "base" },
    ]);
  });

  it("warns in the rendered comment, naming the component and version", async () => {
    const projection = await run({
      releases: [{ tagName: "acme-api@v2.4.1", sha: RELEASE_SHA }],
    });
    const body = render(projection, {
      title: "fix: another thing",
      malformed: false,
    });
    expect(body).toContain("`acme-ui` has no release or tag at its manifest");
    expect(body).toContain("`1.0.0`");
    expect(body).toContain("**Any version shown for it above may be wrong.**");
  });
});

describe("drainBoundaries", () => {
  it("returns nothing twice in a row", () => {
    expect(drainBoundaries()).toEqual([]);
    expect(drainBoundaries()).toEqual([]);
  });

  it("is armed by project even when no caller installed a logger", async () => {
    // armBoundaryWatch is what makes the warning work for an embedder that
    // never asked for logging. Calling it here is a no-op because beforeEach
    // installed one; the assertion is that it does not throw or reset.
    armBoundaryWatch();
    const projection = await run({ releases: RESOLVED });
    expect(projection.unresolved).toEqual([]);
  });
});

describe("mergeUnresolved", () => {
  const found = (path: string) => ({ path, component: path, version: "1.0.0" });

  it("reports a component missing on both sides once", () => {
    expect(mergeUnresolved([found("ui")], [found("ui")])).toEqual([
      { path: "ui", component: "ui", version: "1.0.0", on: "both" },
    ]);
  });

  it("keeps which side a one-sided finding came from", () => {
    expect(mergeUnresolved([found("ui")], [])).toEqual([
      { path: "ui", component: "ui", version: "1.0.0", on: "head" },
    ]);
    expect(mergeUnresolved([], [found("ui")])).toEqual([
      { path: "ui", component: "ui", version: "1.0.0", on: "base" },
    ]);
  });

  it("orders by path, so the comment does not reshuffle between runs", () => {
    expect(
      mergeUnresolved([found("ui"), found("api")], []).map((u) => u.path),
    ).toEqual(["api", "ui"]);
  });
});
