/**
 * These tests drive real release-please against fixtures.
 *
 * Every assertion below is a measurement, not a reading of upstream source.
 * That distinction is the reason this package exists: the implementation it
 * replaces mirrored five release-please rules in another language, and two of
 * them were mirrored backwards — hidden types were believed to release, and a
 * miscased type was believed to fail outright. Reading the source produced
 * both errors; running it produced both corrections.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { setLogger } from "release-please";
import { UPSTREAM_BATCH_SIZE } from "./history.js";
import { fakeScm, RELEASE_SHA, walkRecord } from "./fake-scm.fixture.js";
import type { WalkRecord } from "./fake-scm.fixture.js";
import {
  COMMIT_BATCH_SIZE,
  COMMIT_SEARCH_DEPTH,
  project,
  tagFor,
} from "./project.js";
import type { Projection } from "./project.js";
import { render } from "./render.js";

beforeAll(() => {
  const quiet = () => {};
  setLogger({
    debug: quiet,
    info: quiet,
    warn: quiet,
    error: quiet,
    trace: quiet,
    fatal: quiet,
  } as Parameters<typeof setLogger>[0]);
});

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

/** run projects one pull request title/body against the fixture repository. */
async function run(
  title: string,
  body = "",
  files = ["api/src/x.ts"],
  commits: { message: string; files: string[] }[] = [],
): Promise<Projection> {
  return project({
    github: fakeScm({
      config: CONFIG,
      manifest: MANIFEST,
      commits: commits.map((c, i) => ({
        sha: `feed${i}`,
        message: c.message,
        files: c.files,
      })),
    }),
    config: CONFIG,
    manifest: MANIFEST,
    commit: {
      title,
      body,
      files,
      number: 7,
      headSha: "abcdef1234567890",
      headBranch: "topic",
      baseBranch: "master",
    },
  });
}

/** versions is the projected version per component, for terse assertions. */
function versions(projection: Projection): Record<string, string> {
  return Object.fromEntries(
    projection.projected.map((r) => [r.component, r.version]),
  );
}

describe("the bump the type implies", () => {
  it("bumps the minor for a feat", async () => {
    expect(versions(await run("feat: a thing"))).toEqual({
      "acme-api": "2.5.0",
    });
  });

  it("bumps the patch for a fix", async () => {
    expect(versions(await run("fix: a thing"))).toEqual({
      "acme-api": "2.4.2",
    });
  });

  it("bumps the major for a breaking change", async () => {
    expect(versions(await run("feat!: a thing"))).toEqual({
      "acme-api": "3.0.0",
    });
  });

  it("treats a BREAKING CHANGE footer like the bang", async () => {
    const p = await run("fix: a thing", "BREAKING CHANGE: the API moved");
    expect(versions(p)).toEqual({ "acme-api": "3.0.0" });
  });
});

describe("types that open no release at all", () => {
  // The rule the mirrored implementation got backwards. The versioning
  // strategy ends in a bare PatchVersionUpdate(), which reads as "everything
  // releases"; the release is dropped later, when the notes render empty.
  it.each(["docs", "chore", "ci", "refactor", "test", "build", "style"])(
    "releases nothing for a hidden %s type",
    async (type) => {
      expect(versions(await run(`${type}: a thing`))).toEqual({});
    },
  );

  it("releases nothing for an unrecognized type", async () => {
    expect(versions(await run("wip: a thing"))).toEqual({});
  });

  it("releases nothing for a subject that is not a Conventional Commit", async () => {
    expect(versions(await run("just some words"))).toEqual({});
  });

  it("lets a breaking change escape the hidden filter", async () => {
    expect(versions(await run("docs!: a thing"))).toEqual({
      "acme-api": "3.0.0",
    });
  });
});

describe("a miscased type", () => {
  // The second rule read backwards. `Feat:` does not fail — it renders a
  // correct-looking Features entry (the changelog preset lowercases before
  // matching) while bumping only a patch (the versioning strategy compares
  // the type literally). A feature ships as a patch with no error anywhere,
  // which is why the title gate rejects anything outside the lowercase list.
  it("renders as a feature but bumps only a patch", async () => {
    const projection = await run("Feat: a thing");
    expect(versions(projection)).toEqual({ "acme-api": "2.4.2" });
    expect(projection.projected[0]?.notes).toContain("Features");
  });
});

describe("Release-As", () => {
  it("forces the version when the note parses as a trailer", async () => {
    const projection = await run("fix: a thing", "Release-As: 9.9.9");
    expect(versions(projection)).toEqual({ "acme-api": "9.9.9" });
    expect(projection.ignoredReleaseAs).toBeUndefined();
  });

  it("escapes the hidden filter, so a docs commit can release", async () => {
    expect(versions(await run("docs: a thing", "Release-As: 9.9.9"))).toEqual({
      "acme-api": "9.9.9",
    });
  });

  // The failure that cost a release on 2026-08-31, and the reason the
  // warning exists: an attribution footer was appended below the note, and
  // the pull request body is the squash commit's body.
  // release-please recomputed the original version with no error anywhere.
  it("is silently ignored when non-trailer text follows it", async () => {
    const body = "Release-As: 9.9.9\n\n---\n_Generated by a bot_";
    const projection = await run("fix: a thing", body);
    expect(versions(projection)).toEqual({ "acme-api": "2.4.2" });
    expect(projection.ignoredReleaseAs).toBe("9.9.9");
  });

  it("survives another trailer below it", async () => {
    const body = "Release-As: 9.9.9\nCo-authored-by: Someone <a@b.c>";
    expect(versions(await run("fix: a thing", body))).toEqual({
      "acme-api": "9.9.9",
    });
  });

  it("honours a prerelease version", async () => {
    expect(versions(await run("fix: a thing", "Release-As: 9.9.9-rc.1"))).toEqual({
      "acme-api": "9.9.9-rc.1",
    });
  });

  // A body that discusses the trailer is not asking for a version, and in a
  // repository whose contributors have been bitten by the placement rule such
  // a body is ordinary. Every case below
  // leaves release-please at the version the type implies, so warning that a
  // note "was ignored" would be a warning about nothing.
  it.each([
    ["a code fence", "How to fix a bump:\n\n```\nRelease-As: 9.9.9\n```\n\nDone."],
    ["backticks", "The footer is `Release-As: 9.9.9`, dead last."],
    ["a blockquote", "> Release-As: 9.9.9\n\nis what #81 should have carried."],
    ["indentation", "It ended with:\n\n    Release-As: 9.9.9\n\nand a rule below."],
    [
      "a placeholder version",
      "Append the footer yourself:\n\nRelease-As: x.y.z\n\nThen merge.",
    ],
  ])("does not read a mention in %s as an ask", async (_what, body) => {
    const projection = await run("fix: a thing", body);
    expect(versions(projection)).toEqual({ "acme-api": "2.4.2" });
    expect(projection.releaseAs).toBeUndefined();
    expect(projection.ignoredReleaseAs).toBeUndefined();
  });

  // release-please reads a version out of a note with an unanchored match, so
  // the prose line here is the one it honours. A note that forced a version
  // is not an ignored note, whichever line it came from.
  it("names the note release-please honoured, not the last one written", async () => {
    const body = "Release-As: 1.1.1 was what we wrote before.\n\nRelease-As: 9.9.9";
    const projection = await run("fix: a thing", body);
    expect(versions(projection)).toEqual({ "acme-api": "1.1.1" });
    expect(projection.releaseAs).toBe("1.1.1");
    expect(projection.ignoredReleaseAs).toBeUndefined();
  });

  // The one placement of a placeholder that is not silent: as a real trailer
  // it reaches Version.parse, which throws. The action fails the job rather
  // than reporting a projection, and there is nothing here to soften that.
  it("fails loudly on a trailer whose version does not parse", async () => {
    await expect(run("fix: a thing", "Release-As: x.y.z")).rejects.toThrow(
      "unable to parse version string",
    );
  });

  it("leaves a note inside a nested code fence alone", async () => {
    // A repository whose contributors have been bitten by the placement rule
    // writes documentation about it, and documentation about a fenced example
    // needs a longer fence around it. CommonMark closes a fence only on the
    // same character, at least as long as the one that opened it; tracking
    // just the character let the inner three-backtick line close the outer
    // four-backtick one, and the note in between became a real ask that
    // release-please then appeared to have ignored.
    const body = [
      "How to force a version:",
      "",
      "````markdown",
      "```",
      "Release-As: 9.9.9",
      "```",
      "````",
      "",
      "and that is all.",
    ].join("\n");
    const projection = await run("fix: a thing", body);
    expect(versions(projection)).toEqual({ "acme-api": "2.4.2" });
    expect(projection.ignoredReleaseAs).toBeUndefined();
    expect(projection.releaseAs).toBeUndefined();
  });

  // Deliberate: a bare note mid-body is the exact shape of the failure this
  // warns about -- non-trailer text below it -- so it is read as an ask.
  it("reads a note left above prose as one that will be ignored", async () => {
    const body = "The commit ended with\nRelease-As: 9.9.9\nand then more prose.";
    const projection = await run("fix: a thing", body);
    expect(versions(projection)).toEqual({ "acme-api": "2.4.2" });
    expect(projection.ignoredReleaseAs).toBe("9.9.9");
  });
});

// splitFiles does not run release-please's normalizePaths over the configured
// paths, which raises the question of what a path in some other spelling
// does. Measured: nothing releases, because manifest.ts looks its split
// commits up by the raw config key while CommitSplit files them under the
// normalized one, so the package sees no commits at all. This preview's
// "no changed file is under a package path" agrees with that, and the
// spelling is worth catching in the config instead, which validating it
// against release-please's own schema does not do.
describe("a package path release-please would normalize", () => {
  it.each(["api/", "/api"])("releases nothing for %s", async (path) => {
    const config = {
      "separate-pull-requests": true,
      packages: {
        [path]: {
          "release-type": "simple",
          component: "acme-api",
          "include-component-in-tag": true,
          "tag-separator": "@",
        },
      },
    };
    const manifest = { [path]: "2.4.1" };
    const projection = await project({
      github: fakeScm({ config, manifest, commits: [] }),
      config,
      manifest,
      commit: {
        title: "feat: a thing",
        body: "",
        files: ["api/src/x.ts"],
        number: 7,
        headSha: "abcdef1234567890",
        headBranch: "topic",
        baseBranch: "master",
      },
    });
    expect(versions(projection)).toEqual({});
    expect([...projection.touched.keys()]).toEqual([]);
  });
});

describe("what is already pending on the target branch", () => {
  it("reports a release this pull request did not cause", async () => {
    const projection = await run("docs: a thing", "", ["api/README.md"], [
      { message: "feat: something merged earlier", files: ["api/src/y.ts"] },
    ]);
    expect(versions(projection)).toEqual({ "acme-api": "2.5.0" });
    expect(
      Object.fromEntries(projection.pending.map((r) => [r.component, r.version])),
    ).toEqual({ "acme-api": "2.5.0" });
  });

  it("absorbs this pull request's patch into a pending minor", async () => {
    const projection = await run("fix: a thing", "", ["api/src/x.ts"], [
      { message: "feat: something merged earlier", files: ["api/src/y.ts"] },
    ]);
    expect(versions(projection)).toEqual({ "acme-api": "2.5.0" });
  });

  it("is empty when the target branch has nothing unreleased", async () => {
    const projection = await run("feat: a thing");
    expect(projection.pending).toEqual([]);
  });
});

describe("which components a pull request reaches", () => {
  it("releases only the component whose files it touches", async () => {
    expect(versions(await run("feat: a thing", "", ["ui/index.html"]))).toEqual(
      { "acme-ui": "1.1.0" },
    );
  });

  it("releases both when it touches both", async () => {
    const projection = await run("feat: a thing", "", [
      "api/src/x.ts",
      "ui/index.html",
    ]);
    expect(versions(projection)).toEqual({
      "acme-api": "2.5.0",
      "acme-ui": "1.1.0",
    });
  });

  it("releases nothing when no file is under a package path", async () => {
    expect(versions(await run("feat: a thing", "", ["README.md"]))).toEqual({});
  });
});

describe("the rendered notes", () => {
  it("carries release-please's own changelog entry", async () => {
    const projection = await run("feat: add a widget");
    expect(projection.projected[0]?.notes).toContain("add a widget");
  });
});

describe("the release sentinel", () => {
  it("stops the walk at the last release", async () => {
    // A commit below the sentinel is already released and must not count.
    const projection = await project({
      github: fakeScm({
        config: CONFIG,
        manifest: MANIFEST,
        commits: [],
        releases: [
          { tagName: "acme-api@v2.4.1", sha: RELEASE_SHA },
          { tagName: "acme-ui@v1.0.0", sha: RELEASE_SHA },
        ],
      }),
      config: CONFIG,
      manifest: MANIFEST,
      commit: {
        title: "docs: a thing",
        body: "",
        files: ["api/src/x.ts"],
        number: 1,
        headSha: "abc",
        headBranch: "topic",
        baseBranch: "master",
      },
    });
    expect(projection.projected).toEqual([]);
  });
});

describe("a repository that does not separate its release pull requests", () => {
  // `separate-pull-requests: true` is what the tests above assume; it is not
  // release-please's default. Without it every
  // component with pending changes is aggregated into one pull request
  // carrying one `releaseData` entry each, on a branch with no
  // `--components--` segment. Reading only the branch there would report a
  // single release for a merge that cuts two tags.
  const CONFIG_AGGREGATED = {
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

  async function aggregated(title: string, files: string[]): Promise<Projection> {
    return project({
      github: fakeScm({ config: CONFIG_AGGREGATED, manifest: MANIFEST }),
      config: CONFIG_AGGREGATED,
      manifest: MANIFEST,
      commit: {
        title,
        body: "",
        files,
        number: 7,
        headSha: "abcdef1234567890",
        headBranch: "topic",
        baseBranch: "master",
      },
    });
  }

  it("reports one release per component the merge would tag", async () => {
    const p = await aggregated("feat: a thing", ["api/src/x.ts", "ui/src/y.ts"]);
    expect(versions(p)).toEqual({ "acme-api": "2.5.0", "acme-ui": "1.1.0" });
  });

  it("keeps each component's own notes with it", async () => {
    const p = await aggregated("fix: a thing", ["api/src/x.ts", "ui/src/y.ts"]);
    const api = p.projected.find((r) => r.component === "acme-api");
    expect(api?.notes).toContain("a thing");
    expect(p.projected).toHaveLength(2);
  });

  it("still reports a single-component release from the one entry", async () => {
    const p = await aggregated("feat: a thing", ["api/src/x.ts"]);
    expect(versions(p)).toEqual({ "acme-api": "2.5.0" });
  });
});

// The join key between this preview's own view of the config and
// release-please's answer is the component name, and the config need not
// spell one: several release types derive it. Reading the config alone left
// such a package named "" — matching no release, so the table came out empty
// and the comment said "None" for a merge that would really cut a tag.
describe("a package whose config names no component", () => {
  const CONFIG_NODE = {
    "separate-pull-requests": true,
    packages: {
      api: { "release-type": "node" },
    },
  };
  const MANIFEST_NODE = { api: "2.4.1" };

  async function node(): Promise<Projection> {
    return project({
      github: fakeScm({
        config: CONFIG_NODE,
        manifest: MANIFEST_NODE,
        files: {
          "api/package.json": JSON.stringify({
            name: "@acme/api",
            version: "2.4.1",
          }),
        },
        releases: [{ tagName: "api-v2.4.1", sha: RELEASE_SHA }],
      }),
      config: CONFIG_NODE,
      manifest: MANIFEST_NODE,
      commit: {
        title: "feat: a thing",
        body: "",
        files: ["api/src/x.ts"],
        number: 7,
        headSha: "abcdef1234567890",
        headBranch: "topic",
        baseBranch: "master",
      },
    });
  }

  it("takes the name release-please derives, not the empty string", async () => {
    const projection = await node();
    // release-please strips the scope: `@acme/api` releases as `api`.
    expect(versions(projection)).toEqual({ api: "2.5.0" });
    expect(projection.packages).toEqual([
      expect.objectContaining({ path: "api", releaseComponent: "api" }),
    ]);
  });

  it("renders the release rather than reporting none", async () => {
    const out = render(await node(), { title: "feat: a thing", malformed: false });
    expect(out).toContain("`api-v2.5.0`");
    expect(out).not.toContain("None —");
  });
});

// release-please attributes releases itself, and its plugins release
// components no file of the pull request is under. `linked-versions` is the
// plain case: touching one component bumps every component in the group.
// Filtering the projection down to the touched components dropped those
// rows, understating the merge or reporting nothing for it at all.
describe("a release for a component the pull request does not touch", () => {
  const CONFIG_LINKED = {
    "separate-pull-requests": true,
    plugins: [
      {
        type: "linked-versions",
        groupName: "acme",
        components: ["acme-api", "acme-ui"],
      },
    ],
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

  async function linked(): Promise<Projection> {
    return project({
      github: fakeScm({ config: CONFIG_LINKED, manifest: MANIFEST }),
      config: CONFIG_LINKED,
      manifest: MANIFEST,
      commit: {
        title: "feat: a thing",
        body: "",
        files: ["api/src/x.ts"],
        number: 7,
        headSha: "abcdef1234567890",
        headBranch: "topic",
        baseBranch: "master",
      },
    });
  }

  it("projects the linked component release-please carries along", async () => {
    expect(versions(await linked())).toEqual({
      "acme-api": "2.5.0",
      "acme-ui": "2.5.0",
    });
    expect((await linked()).touched.has("ui")).toBe(false);
  });

  it("keeps it in the table", async () => {
    const out = render(await linked(), {
      title: "feat: a thing",
      malformed: false,
    });
    expect(out).toContain("`acme-api@v2.5.0`");
    expect(out).toContain("`acme-ui@v2.5.0`");
  });
});

describe("a repository release-please runs without a manifest", () => {
  // release-please's plain mode: `release-type:` on the action, no
  // release-please-config.json and no .release-please-manifest.json. This is
  // how a single-package repository is normally released, and it is what this
  // action's own repository does -- so without it the action could not
  // project its own releases.
  //
  // `Manifest.fromConfig` is public surface alongside `fromManifest`, and the
  // synthetic-commit wrapper is indifferent to which built the manifest: it
  // wraps the `GitHub`, not the `Manifest`.
  const PLAIN = { releaseType: "node" as const };

  /** plain projects one pull request against a fixture repository holding a
   * package.json and one release tag, which is what plain mode reads. */
  async function plain(
    title: string,
    body = "",
    files = ["src/x.ts"],
  ): Promise<Projection> {
    return project({
      github: fakeScm({
        config: {},
        manifest: {},
        releases: [{ tagName: "v2.4.1", sha: RELEASE_SHA }],
        files: {
          "package.json": JSON.stringify({ name: "widgets", version: "2.4.1" }),
        },
      }),
      config: {},
      manifest: {},
      plain: PLAIN,
      commit: {
        title,
        body,
        files,
        number: 7,
        headSha: "abcdef1234567890",
        headBranch: "topic",
        baseBranch: "master",
      },
    });
  }

  it("projects a release with no config or manifest file anywhere", async () => {
    const p = await plain("feat: a thing");
    expect(p.projected.map((r) => r.version)).toEqual(["2.5.0"]);
  });

  it("still lets a hidden type release nothing", async () => {
    // The rule that matters most in the comment, and it is upstream's, not
    // this action's -- so it has to hold identically in both modes.
    expect((await plain("chore: tidy")).projected).toEqual([]);
  });

  it("takes the current version from the tag, since no manifest names it", async () => {
    const p = await plain("fix: a thing");
    expect(p.packages).toHaveLength(1);
    expect(p.packages[0]?.current).toBe("2.4.1");
  });

  it("owns the whole repository, so any changed file counts", async () => {
    // The single package sits at the root, and splitFiles hands a root
    // package every file -- including one at the repository root, which in
    // manifest mode belongs to no component at all.
    const p = await plain("feat: a thing", "", ["README.md"]);
    expect([...p.touched.keys()]).toEqual(["."]);
  });

  it("spells the tag without a component", async () => {
    // A single-package repository tags `v1.2.3`. include-component-in-tag
    // defaults to false here, unlike manifest mode where it defaults to true.
    const p = await plain("feat: a thing");
    const pkg = p.packages[0]!;
    expect(tagFor(pkg, p.projected[0]!.version)).toBe("v2.5.0");
  });

  it("spells it the same way release-please's own notes do", async () => {
    // The default has to reach release-please, not just this side of it.
    // `Strategy` defaults `includeComponentInTag` to true while
    // `latestReleaseVersion` reads it off the config, where undefined is
    // false -- so leaving it unset had one half of the same run looking for
    // `v2.4.1` and the other writing `widgets-v2.5.0`, and the comment
    // carried both: a Tag column and a changelog preview naming different
    // tags for one release.
    const p = await plain("feat: a thing");
    const tag = tagFor(p.packages[0]!, p.projected[0]!.version);
    expect(p.projected[0]!.notes).toContain(`...${tag}`);
    expect(p.projected[0]!.notes).not.toContain("widgets-v");
  });

  it("attributes the release to no component, so the row is kept", async () => {
    // getComponent() is the empty string when the component stays out of the
    // tags, and that is the name the row is joined by.
    const p = await plain("feat: a thing");
    expect(p.projected[0]!.component).toBe("");
    expect(p.packages[0]!.releaseComponent).toBe("");
    expect(render(p, { title: "feat: a thing", malformed: false })).toContain(
      "| **2.5.0** |",
    );
  });

  it("honours a Release-As footer, as it does with a manifest", async () => {
    const p = await plain("fix: a thing", "Release-As: 9.9.9");
    expect(p.projected.map((r) => r.version)).toEqual(["9.9.9"]);
  });
});

describe("a pull request that introduces release-please itself", () => {
  // The shape that broke this action on its own repository: PR #1's base was
  // an empty `master`, and `release-type: node` reads `package.json` from the
  // target branch to derive the component name. It is not there yet -- that
  // pull request is the one adding it -- so `Manifest.fromConfig` threw
  // `_MissingRequiredFileError` and the job went red.
  //
  // Adopting release-please always has this shape, so it has to work: serve
  // the head's copy of the files the pull request changes, exactly as the
  // config and manifest are already served in manifest mode.
  const PKG = JSON.stringify({ name: "widgets", version: "0.0.0" });

  /** bare is a repository whose target branch has no package.json at all. */
  function bare() {
    return fakeScm({ config: {}, manifest: {}, releases: [], files: {} });
  }

  async function project1(readHeadFile?: (p: string) => string | undefined) {
    return project({
      github: bare(),
      config: {},
      manifest: {},
      plain: { releaseType: "node" as const },
      ...(readHeadFile ? { readHeadFile } : {}),
      commit: {
        title: "feat: extract the tool as a standalone action",
        body: "",
        files: ["package.json", "src/a.ts"],
        number: 1,
        headSha: "abcdef1234567890",
        headBranch: "topic",
        baseBranch: "master",
      },
    });
  }

  it("fails without the head's package.json, which is the bug", async () => {
    await expect(project1()).rejects.toThrow(/package\.json/);
  });

  it("projects the release once the head's package.json is served", async () => {
    const p = await project1((path) => (path === "package.json" ? PKG : undefined));
    expect(p.projected.map((r) => r.version)).toEqual(["1.0.0"]);
    expect(p.packages[0]?.component).toBe("widgets");
  });

  it("reports nothing pending, since the target branch cannot release", async () => {
    // The second pass runs against the target branch as it stands, where
    // release-please cannot build a manifest at all. That is not an error and
    // not unknown: a branch it cannot run on releases nothing.
    const p = await project1((path) => (path === "package.json" ? PKG : undefined));
    expect(p.pending).toEqual([]);
  });

  it("serves the head copy only for files the pull request changes", async () => {
    const seen: string[] = [];
    await project1((path) => {
      seen.push(path);
      return path === "package.json" ? PKG : undefined;
    });
    expect(seen).toContain("package.json");
  });
});

// A separate release pull request carries the authoritative version on the
// pull request itself, so that is where the version comes from. The component
// is a different question: the branch names the package release-please knows
// it by, which is not the name it attributes the *release* to. A package that
// keeps its component out of its tags releases under no component at all, and
// reading the branch there produced a component nothing could be joined to --
// so render dropped the row and the comment said "None" for a merge that cuts
// a tag.
describe("a package that keeps its component out of its tags", () => {
  const CONFIG_BARE = {
    "separate-pull-requests": true,
    packages: {
      api: {
        "release-type": "simple",
        component: "acme-api",
        "include-component-in-tag": false,
      },
    },
  };
  const MANIFEST_BARE = { api: "2.4.1" };

  async function bare(): Promise<Projection> {
    return project({
      github: fakeScm({
        config: CONFIG_BARE,
        manifest: MANIFEST_BARE,
        releases: [{ tagName: "v2.4.1", sha: RELEASE_SHA }],
      }),
      config: CONFIG_BARE,
      manifest: MANIFEST_BARE,
      commit: {
        title: "feat: a thing",
        body: "",
        files: ["api/src/x.ts"],
        number: 7,
        headSha: "abcdef1234567890",
        headBranch: "topic",
        baseBranch: "master",
      },
    });
  }

  it("attributes the release to no component, as release-please does", async () => {
    const projection = await bare();
    expect(projection.projected).toEqual([
      expect.objectContaining({ component: "", version: "2.5.0" }),
    ]);
    expect(projection.packages).toEqual([
      expect.objectContaining({ path: "api", releaseComponent: "" }),
    ]);
  });

  it("keeps the row, rather than reporting none", async () => {
    const out = render(await bare(), { title: "feat: a thing", malformed: false });
    expect(out).toContain("| **2.5.0** |");
    expect(out).not.toContain("None —");
  });
});

describe("the commit walk", () => {
  /** walked projects one pull request and reports what the repository's
   * history was asked for on the way. */
  async function walked(options: {
    config?: Record<string, unknown>;
    releases?: { tagName: string; sha: string }[];
    commits?: number;
  }): Promise<WalkRecord> {
    const config = options.config ?? CONFIG;
    const record = walkRecord();
    const commits = Array.from({ length: options.commits ?? 3 }, (_, i) => ({
      sha: `feed${i}`,
      message: "fix: a thing",
      files: ["api/src/x.ts"],
    }));
    await project({
      github: fakeScm({
        config,
        manifest: MANIFEST,
        ...(options.releases ? { releases: options.releases } : {}),
        commits,
        record,
      }),
      config,
      manifest: MANIFEST,
      commit: {
        title: "feat: a thing",
        body: "",
        files: ["api/src/x.ts"],
        number: 7,
        headSha: "abcdef1234567890",
        headBranch: "topic",
        baseBranch: "master",
      },
    });
    return record;
  }

  it("reads the history once for both passes", async () => {
    // The two passes read the same branch, so the second one is served from
    // what the first read. Unmemoized this is the whole cost paid twice.
    const record = await walked({ commits: 5 });
    expect(record.walks).toHaveLength(1);
    expect(new Set(record.yielded).size).toBe(record.yielded.length);
  });

  it("asks for pages ten times the size release-please defaults to", async () => {
    const record = await walked({});
    // No cap is written here. The one read serves several consumers asking
    // different depths -- in plain mode the release search asks 250 and the
    // pull request build asks 500 -- so each cap is applied when the cache is
    // replayed rather than to the read itself, which nothing may truncate.
    // See src/history.ts.
    expect(record.walks[0]?.options).toEqual({
      batchSize: COMMIT_BATCH_SIZE,
      backfillFiles: true,
    });
  });

  it("leaves a repository that tunes the walk with what it configured", async () => {
    // A projection describes the release-please run the merge will get. That
    // run reads these keys from the repository's own config, so a value set
    // there is not this action's to overrule.
    const record = await walked({
      config: { ...CONFIG, "commit-batch-size": 25, "commit-search-depth": 40 },
    });
    expect(record.walks[0]?.options).toEqual({
      batchSize: 25,
      backfillFiles: true,
    });
  });

  it("pages as release-please will, when the configured size is one it drops", async () => {
    // release-please resolves its batch size with `||`, so a zero reaches the
    // walk as ten -- and the shared read has to fetch in the pages the run
    // being projected fetches in, not in this action's larger ones.
    const record = await walked({ config: { ...CONFIG, "commit-batch-size": 0 } });
    expect(record.walks[0]?.options).toEqual({
      batchSize: UPSTREAM_BATCH_SIZE,
      backfillFiles: true,
    });
  });

  it("stops reading where the configured search depth does", async () => {
    // The other half of the same rule, and the one a cap on the shared read
    // would have broken: the depth this run gets is the repository's, applied
    // as release-please applies it -- between pages, so a walk capped at 40
    // in pages of 25 reads 50.
    const record = await walked({
      config: { ...CONFIG, "commit-batch-size": 25, "commit-search-depth": 40 },
      commits: 250,
    });
    expect(record.yielded).toHaveLength(50);
  });

  it("stops reading at the depth release-please defaults to", async () => {
    // The default written out in project.ts, checked the only way it is now
    // observable: a walk long enough to reach it. It bounds the read because
    // the local commit-file index is built to the same number, so a deeper
    // walk would go to the API for what the index stops short of.
    const record = await walked({ commits: COMMIT_SEARCH_DEPTH + 100 });
    expect(record.yielded).toHaveLength(COMMIT_SEARCH_DEPTH);
  });

  it("stops itself where release-please says, not where this does", async () => {
    // Nothing here truncates a walk: release-please stops at the release
    // commit, and a walk that does not stop is one whose answer the comment
    // is already warning about. A cap would have to fire on a new
    // component's first release too, which legitimately replays everything.
    const record = await walked({ commits: 250 });
    expect(record.yielded).toHaveLength(251);
  });
});
