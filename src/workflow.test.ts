/**
 * The comparison between this action's inputs and the release workflow's,
 * and — at least as important — everything it declines to compare.
 *
 * A note here is an accusation: it tells a reader that the number above it
 * describes a release their repository will not cut. So the tests come in two
 * halves. The first checks that a real disagreement is found and named. The
 * second checks the silences, one per way of being unsure, because a parser
 * that guesses at a workflow it cannot read would put its guess on the
 * comment that has to be trustworthy.
 */

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callersIn,
  compareReleaseWorkflow,
  governing,
  WORKFLOW_DIR,
} from "./workflow.js";
import type { Given } from "./workflow.js";
import { DEFAULT_CONFIG_FILE, DEFAULT_MANIFEST_FILE } from "./project.js";
import type { PlainConfig } from "./project.js";

/** RELEASE is the ordinary release workflow: one step, plain mode, `node`. */
const RELEASE = `
name: Release Please
on:
  push:
    branches: [master]
jobs:
  release-please:
    runs-on: ubuntu-latest
    steps:
      - uses: googleapis/release-please-action@v5
        with:
          release-type: node
          token: \${{ steps.app-token.outputs.token || github.token }}
`;

/** checkout writes workflows into a throwaway repository root. */
function checkout(workflows: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "projected-releases-workflow-"));
  const dir = join(root, WORKFLOW_DIR);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(workflows)) {
    writeFileSync(join(dir, name), text);
  }
  return root;
}

/** compare runs the comparison over a checkout holding those workflows. */
function compare(
  workflows: Record<string, string>,
  over: Partial<Given> & { plain?: PlainConfig | undefined } = {},
) {
  return compareReleaseWorkflow({
    configFile: DEFAULT_CONFIG_FILE,
    manifestFile: DEFAULT_MANIFEST_FILE,
    base: "master",
    root: checkout(workflows),
    plain: { releaseType: "node" },
    ...over,
  });
}

/** step builds a release workflow around one `with:` block. */
function step(inputs: Record<string, string>): string {
  const block = Object.entries(inputs)
    .map(([name, value]) => `          ${name}: ${value}`)
    .join("\n");
  return `
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: googleapis/release-please-action@v5
        with:
${block}
`;
}

describe("comparing this action's inputs with the release workflow's", () => {
  it("says nothing when the two agree", () => {
    // The dogfood case, and the one that has to stay quiet: this repository
    // passes `release-type: node` in both places.
    const result = compare({ "release-please.yml": RELEASE });
    expect(result.decided).toBe(true);
    expect(result.notes).toEqual([]);
  });

  it("names a value the release will use and the projection did not", () => {
    const result = compare({
      "release.yml": step({
        "release-type": "node",
        "versioning-strategy": "always-bump-patch",
      }),
    });
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain("`versioning-strategy: always-bump-patch`");
    // The other half of the sentence: what this action was given, and that
    // its absence is not nothing but release-please's own default.
    expect(result.notes[0]).toContain("`default`");
    expect(result.notes[0]).toContain("the release will use the first");
  });

  it("names a value the projection was given and the release will not use", () => {
    const result = compare(
      { "release.yml": step({ "release-type": "node" }) },
      { plain: { releaseType: "node", releaseAs: "1.2.3" } },
    );
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain("`release-as: 1.2.3`");
  });

  it("compares the two names one setting has", () => {
    // `package-path` here is `path` there, and a note using one name for both
    // sends the reader to edit the wrong file.
    const result = compare(
      { "release.yml": step({ "release-type": "node", path: "pkg/api" }) },
      { plain: { releaseType: "node" } },
    );
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain("`path: pkg/api`");
    expect(result.notes[0]).toContain("no `package-path`, so `.`");
  });

  it("reads a boolean written as YAML rather than as a string", () => {
    const result = compare(
      {
        "release.yml": step({
          "release-type": "node",
          "include-component-in-tag": "true",
        }),
      },
      { plain: { releaseType: "node" } },
    );
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain("`include-component-in-tag: true`");
  });

  it("takes a value both sides leave at the same default as agreement", () => {
    // Neither side has to type a default for the two to agree on it: an empty
    // `path` and no `path` at all are both the repository root, and
    // release-please-action's own `include-component-in-tag` default is false
    // -- the value this action applies when nobody says.
    const result = compare({
      "release.yml": step({
        "release-type": "node",
        path: '""',
        "include-component-in-tag": "false",
        "versioning-strategy": "default",
      }),
    });
    expect(result.notes).toEqual([]);
  });

  it("reports the mode the workflow selects, when this action selected the other", () => {
    const manifest = compare(
      { "release.yml": step({ "release-type": "python" }) },
      { plain: undefined },
    );
    expect(manifest.notes).toHaveLength(1);
    expect(manifest.notes[0]).toContain("`release-type: python`");
    expect(manifest.notes[0]).toContain("will not read `release-please-config.json`");

    const plain = compare({
      "release.yml": step({ "config-file": "release-please-config.json" }),
    });
    expect(plain.notes).toHaveLength(1);
    expect(plain.notes[0]).toContain("`release-type` is set here");
    expect(plain.notes[0]).toContain("without one");
  });

  it("compares nothing else once the modes disagree", () => {
    // Two runs reading different configurations entirely have no shared
    // `versioning-strategy` to differ about, and a second note about one
    // would be noise on top of the finding that matters.
    const result = compare(
      {
        "release.yml": step({
          "release-type": "node",
          "versioning-strategy": "always-bump-patch",
        }),
      },
      { plain: undefined },
    );
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain("release-type: node");
  });

  it("compares the file paths a manifest release reads", () => {
    const result = compare(
      { "release.yml": step({ "config-file": "ci/release-please.json" }) },
      { plain: undefined },
    );
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain("`config-file: ci/release-please.json`");
    expect(result.notes[0]).toContain("`config-file: release-please-config.json`");
  });

  it("compares what this action was given, not only what the workflow passes", () => {
    // The mirror of the cases above: every plain-mode value set here and left
    // alone there. `pkg/` and `pkg` are the same directory, so that one is
    // agreement and the other three are notes.
    const result = compare(
      { "release.yml": step({ "release-type": "node", path: "pkg/" }) },
      {
        plain: {
          releaseType: "node",
          path: "pkg",
          includeComponentInTag: true,
          versioning: "always-bump-patch",
        },
      },
    );
    expect(result.notes).toHaveLength(2);
    expect(result.notes.join("\n")).not.toContain("package-path");
    expect(result.notes[0]).toContain("`include-component-in-tag: true`");
    expect(result.notes[1]).toContain("`versioning-strategy: always-bump-patch`");
  });

  it("reports an input release-please-action cannot pass at all", () => {
    // `component` and `tag-separator` have no input on release-please-action,
    // so a repository it releases cannot be passing them -- the projection is
    // modelling a tag nothing will cut.
    const result = compare(
      { "release.yml": step({ "release-type": "node" }) },
      { plain: { releaseType: "node", component: "widgets" } },
    );
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain("`component` is set here");
    expect(result.notes[0]).toContain("`widgets`");

    const separator = compare(
      { "release.yml": step({ "release-type": "node" }) },
      { plain: { releaseType: "node", tagSeparator: "@" } },
    );
    expect(separator.notes).toHaveLength(1);
    expect(separator.notes[0]).toContain("`tag-separator` is set here");
  });
});

describe("what the comparison declines to do", () => {
  // Each of these is a repository doing nothing wrong, or one this cannot
  // read. `decided` false leaves buildComment's checkout-only note in place,
  // which is the behaviour that existed before any of this.
  it("says nothing when no workflow calls release-please-action", () => {
    const result = compare({
      "test.yml": "jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v7\n",
    });
    expect(result).toEqual({ decided: false, notes: [] });
  });

  it("says nothing when there is no checkout to read", () => {
    const result = compareReleaseWorkflow({
      configFile: DEFAULT_CONFIG_FILE,
      manifestFile: DEFAULT_MANIFEST_FILE,
      base: "master",
      root: join(tmpdir(), "projected-releases-does-not-exist"),
      plain: { releaseType: "node" },
    });
    expect(result).toEqual({ decided: false, notes: [] });
  });

  it("says nothing about a workflow that does not parse", () => {
    // A file GitHub may well be running: this cannot read it, and a note
    // computed from half a parse would be worse than the silence.
    const result = compare({
      "release.yml": "jobs:\n  release:\n    steps:\n  - uses: [unbalanced\n",
    });
    expect(result).toEqual({ decided: false, notes: [] });
  });

  it("says nothing when two callers could both be the releaser", () => {
    const result = compare({
      "release.yml": step({ "release-type": "python" }),
      "other.yml": step({ "release-type": "ruby" }),
    });
    expect(result).toEqual({ decided: false, notes: [] });
  });

  it("skips a caller releasing some other branch", () => {
    // The maintenance-branch shape: two steps, told apart by `target-branch`,
    // and only one of them describes what merging into `master` cuts.
    const result = compare({
      "maintenance.yml": step({
        "release-type": "python",
        "target-branch": "v1.x",
      }),
      "release.yml": step({ "release-type": "node", "target-branch": "master" }),
    });
    expect(result).toEqual({ decided: true, notes: [] });
  });

  it("says nothing about a value only the runner can resolve", () => {
    const result = compare({
      "release.yml": step({
        "release-type": "node",
        "versioning-strategy": "${{ vars.VERSIONING }}",
      }),
    });
    // Decided, because the mode is still legible: the comparison this can
    // make is made, and the one line it cannot is left out.
    expect(result).toEqual({ decided: true, notes: [] });
  });

  it("stops entirely when the mode itself is an expression", () => {
    // `release-type` decides which values are even comparable, so an
    // expression there is not one line withheld but all of them.
    const result = compare({
      "release.yml": step({ "release-type": "${{ inputs.release-type }}" }),
    });
    expect(result).toEqual({ decided: false, notes: [] });
  });

  it("says nothing when the caller's target branch is an expression", () => {
    // The step may be releasing some other branch entirely, so nothing it
    // passes is known to describe what merging this pull request cuts.
    const result = compare({
      "release.yml": step({
        "release-type": "python",
        "target-branch": "${{ vars.RELEASE_BRANCH }}",
      }),
    });
    expect(result).toEqual({ decided: false, notes: [] });
  });

  it("reads nothing at all when told off", () => {
    const result = compare(
      { "release.yml": step({ "release-type": "python" }) },
      { workflow: "off" },
    );
    expect(result).toEqual({ decided: false, notes: [] });
  });

  it("reads the keywords whatever their case", () => {
    // Anything that is not one of the two keywords is a path, and a path
    // that is not there throws -- so a miscased `Off` matched literally
    // fails the whole run rather than turning the check off.
    const workflows = { "release.yml": step({ "release-type": "python" }) };
    expect(compare(workflows, { workflow: "Off" })).toEqual({
      decided: false,
      notes: [],
    });
    expect(compare(workflows, { workflow: "AUTO" }).notes[0]).toContain(
      "`release-type: python`",
    );
  });
});

describe("finding the caller", () => {
  it("reads the workflow a caller names", () => {
    const root = checkout({ "release.yml": step({ "release-type": "python" }) });
    const result = compareReleaseWorkflow({
      configFile: DEFAULT_CONFIG_FILE,
      manifestFile: DEFAULT_MANIFEST_FILE,
      base: "master",
      root,
      plain: { releaseType: "node" },
      workflow: `${WORKFLOW_DIR}/release.yml`,
    });
    expect(result.notes[0]).toContain("`release-type: python`");
  });

  it("fails on a named workflow that is not there", () => {
    // Unlike every other miss: the caller asked for that file, and reading
    // nothing would leave them with a comparison they believe is happening.
    expect(() =>
      compare({}, { workflow: ".github/workflows/nope.yml" }),
    ).toThrow(/no `\.github\/workflows\/nope\.yml`/);
  });

  it("recognizes a fork and a pinned sha", () => {
    const forked = `
jobs:
  release:
    steps:
      - uses: acme/release-please-action@1f0c8a0e9f0e4a5b8c7d6e5f4a3b2c1d0e9f8a7b
        with:
          release-type: python
`;
    const callers = callersIn(checkout({ "release.yml": forked }), ".github/workflows/release.yml");
    expect(callers).toHaveLength(1);
    expect(callers[0]?.given.get("release-type")).toBe("python");
  });

  it("ignores a step that is not release-please-action", () => {
    const other = `
jobs:
  release:
    steps:
      - uses: actions/checkout@v7
      - run: npm ci
      - uses: googleapis/release-please-action-fork@v4
`;
    expect(
      callersIn(checkout({ "release.yml": other }), ".github/workflows/release.yml"),
    ).toEqual([]);
  });

  it("ignores a `with:` entry that is not a scalar", () => {
    // An empty value and a list are both things a workflow can hold and
    // neither is a value to compare: read as text they would be `` and
    // `a,b`, and a note computed from either would be invented.
    const odd = `
jobs:
  release:
    steps:
      - uses: googleapis/release-please-action@v5
        with:
          release-type:
          extra-files:
            - version.txt
`;
    const callers = callersIn(checkout({ "release.yml": odd }), ".github/workflows/release.yml");
    expect(callers).toHaveLength(1);
    expect(callers[0]?.given.size).toBe(0);
  });

  it("takes a step with no `with:` block as a caller passing nothing", () => {
    const bare = "jobs:\n  release:\n    steps:\n      - uses: googleapis/release-please-action@v5\n";
    const callers = callersIn(checkout({ "release.yml": bare }), ".github/workflows/release.yml");
    expect(callers).toHaveLength(1);
    expect(callers[0]?.given.size).toBe(0);
  });
});

describe("governing", () => {
  const caller = (target?: string) => ({
    file: "release.yml",
    given: new Map(target === undefined ? [] : [["target-branch", target]]),
    unresolved: new Set<string>(),
  });

  /** unknown is a caller whose `target-branch` only the runner can resolve. */
  const unknown = () => ({
    file: "release.yml",
    given: new Map<string, string>(),
    unresolved: new Set(["target-branch"]),
  });

  it("takes a step with no target branch as the one releasing this branch", () => {
    expect(governing([caller()], "master")?.file).toBe("release.yml");
  });

  it("takes none when every caller releases something else", () => {
    expect(governing([caller("v1.x")], "master")).toBeUndefined();
  });

  it("takes none when there is nothing to choose between", () => {
    expect(governing([caller(), caller()], "master")).toBeUndefined();
  });

  it("takes none when the only caller's target branch is an expression", () => {
    // Unset means the default branch; an expression means some branch this
    // file does not name, and reading the second as the first would compare
    // a `master` pull request against the maintenance branch's step.
    expect(governing([unknown()], "master")).toBeUndefined();
  });

  it("takes none when an expression could be the second candidate", () => {
    expect(governing([caller(), unknown()], "master")).toBeUndefined();
  });
});
