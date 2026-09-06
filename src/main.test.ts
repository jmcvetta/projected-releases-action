/**
 * The command line entry point, driven against a fake GitHub over real HTTP.
 *
 * It exists so a projection can be produced from a checkout by hand, which is
 * how one gets compared against the merge that follows it. That makes it the
 * tool a maintainer reaches for when the action's answer looks wrong, so it
 * has to agree with the action -- and the two read the same options from
 * different places, which is exactly the kind of pair that drifts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli } from "./main.js";
import { startFakeGitHub } from "./fake-github-server.fixture.js";
import type { FakeGitHub, FakeRepo } from "./fake-github-server.fixture.js";

/** RELEASED_SHA is the commit the fixture's release points at, which is
 * what bounds the commit walk. */
const RELEASED_SHA = "1".repeat(40);

const REPO: FakeRepo = {
  owner: "acme",
  repo: "widgets",
  branch: "master",
  files: {
    "package.json": JSON.stringify({ name: "widgets", version: "0.0.0" }),
  },
  commits: [],
  releases: [],
};

let fake: FakeGitHub | undefined;
let stdout: string[] = [];

beforeEach(() => {
  stdout = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  // cli() points release-please's logger at stderr, which is the whole reason
  // it does so: the comment body goes to stdout and the logging must not.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fake?.close();
  fake = undefined;
});

const tmp = () => mkdtempSync(join(tmpdir(), "projected-releases-"));

/** flags are the ordinary invocation. `--files` is supplied rather than
 * diffed and `--release-workflow off` reads no workflow, so nothing here
 * depends on the checkout it runs in -- which is this repository, whose own
 * release workflow the comparison would otherwise find and have opinions
 * about. The flag itself is covered below, against a checkout written for
 * it. */
async function flags(
  extra: string[] = [],
  over: Partial<FakeRepo> = {},
): Promise<string[]> {
  fake = await startFakeGitHub({ ...REPO, ...over });
  return [
    "--title", "feat: a thing",
    "--repo", `${REPO.owner}/${REPO.repo}`,
    "--base", REPO.branch,
    "--release-type", "node",
    "--api-url", fake.url,
    "--graphql-url", `${fake.url}/graphql`,
    "--number", "7",
    "--head-sha", "c".repeat(40),
    "--files", "src/b.ts",
    "--release-workflow", "off",
    ...extra,
  ];
}

const printed = () => stdout.join("");

describe("cli", () => {
  it("prints the rendered comment", async () => {
    await cli(await flags());
    expect(printed()).toContain("| **1.0.0** |");
    expect(printed()).toContain("Changelog preview");
  });

  it("writes to a file instead when asked", async () => {
    const out = join(tmp(), "body.md");
    await cli(await flags(["--out", out]));
    expect(readFileSync(out, "utf8")).toContain("| **1.0.0** |");
    // Either the file or standard output, never both: a caller redirecting
    // stdout into the same file would otherwise get it twice.
    expect(printed()).toBe("");
  });

  it("reads the body from a file, so a trailer can be projected", async () => {
    const body = join(tmp(), "body.md");
    writeFileSync(body, "Release-As: 9.9.9\n");
    await cli(await flags(["--body-file", body]));
    expect(printed()).toContain("9.9.9");
  });

  it("says so when it cannot read the commits a merge would write", async () => {
    // An empty range in whatever checkout this suite runs in, which is the
    // same answer a shallow one gives: nothing to model the merge from.
    await cli(
      await flags([
        "--merge-method", "rebase",
        "--diff-base", "HEAD",
        "--head", "HEAD",
      ]),
    );
    expect(printed()).toContain("does not describe this merge");
  });

  it("refuses `auto`, which needs a repository read it does not make", async () => {
    await expect(
      cli(await flags(["--merge-method", "auto"])),
    ).rejects.toThrow(/--merge-method must be one of/);
  });

  it("projects a merge commit from a checkout it is run inside", async () => {
    // The whole command line path for a merge-commit repository: the branch's
    // commits out of git, the merge commit spelled on top, and the title
    // reaching release-please through the merge commit's body.
    const dir = tmp();
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git(["init", "-q", "-b", "master"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    writeFileSync(join(dir, "a.txt"), "a\n");
    git(["add", "a.txt"]);
    git(["commit", "-q", "-m", "chore: start"]);
    git(["checkout", "-q", "-b", "topic"]);
    // The same path `--files` names, so the branch commit and the pull
    // request agree about what changed.
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "b.ts"), "b\n");
    git(["add", "src/b.ts"]);
    git(["commit", "-q", "-m", "fix: a crash"]);

    const cwd = process.cwd();
    try {
      process.chdir(dir);
      await cli(
        await flags([
          "--merge-method", "merge",
          "--diff-base", "master",
          "--head", "topic",
        ]),
      );
    } finally {
      process.chdir(cwd);
    }

    const out = printed();
    expect(out).toContain(", plus a merge commit above them");
    // The branch's `fix:` and, through the merge commit's body, the `feat:`
    // title -- so a minor rather than the patch the branch alone would cut.
    expect(out).toContain("a crash");
    expect(out).toContain("a thing");
  });

  it("requires the two things it cannot guess", async () => {
    await expect(cli(["--repo", "acme/widgets"])).rejects.toThrow(/--title is required/);
    await expect(cli(["--title", "feat: a thing"])).rejects.toThrow(
      /--repo is required, as owner\/name/,
    );
    await expect(
      cli(["--title", "feat: a thing", "--repo", "widgets"]),
    ).rejects.toThrow(/owner\/name/);
  });

  it("takes the changelog types from the flags when they are given", async () => {
    const out = await flags(["--visible-types", "ship,tidy", "--hidden-types", "chore"]);
    await cli(out);
    // `feat` is not among the declared types, so the title cannot become a
    // commit this repository recognizes and the projection is withheld.
    expect(printed()).toContain("malformed PR title");
    expect(printed()).toContain("`ship`");
  });

  it("carries the plain-mode package options through to the tag", async () => {
    await cli(
      await flags([
        "--component", "acme-api",
        "--include-component-in-tag", "true",
        "--tag-separator", "@",
      ]),
    );
    expect(printed()).toContain("acme-api@v1.0.0");
  });

  // The reason `--include-component-in-tag` is a string option rather than a
  // boolean: `parseArgs` reads a boolean as set or unset and drops `=false`,
  // so a boolean here could ask for the component in the tag but never ask
  // for it to be left out -- which is the half that differs from
  // release-please's own default for a component this action was given.
  it("can be told to leave the component out of the tag", async () => {
    await cli(
      await flags([
        "--component", "acme-api",
        "--include-component-in-tag", "false",
      ]),
    );
    // The tag is `v1.0.0`, which the renderer drops as a column because it
    // only repeats the version. The component is nowhere in it, which is the
    // whole assertion.
    expect(printed()).toContain("| **1.0.0** |");
    expect(printed()).not.toContain("acme-api");
  });

  // The action reads its release workflow through the same code, and the two
  // entry points reading one option from different places is the pair that
  // drifts -- which is what this file is for.
  it("compares the plain-mode flags with the release workflow it is pointed at", async () => {
    const root = tmp();
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(root, ".github", "workflows", "release.yml"),
      "jobs:\n  release:\n    steps:\n" +
        "      - uses: googleapis/release-please-action@v5\n" +
        "        with:\n          release-type: node\n" +
        "          versioning-strategy: always-bump-patch\n",
    );
    await cli(
      await flags(["--repo-root", root, "--release-workflow", "auto"]),
    );
    expect(printed()).toContain("`versioning-strategy: always-bump-patch`");
  });

  it("refuses a value for it that is neither", async () => {
    await expect(
      cli(await flags(["--include-component-in-tag", "yes"])),
    ).rejects.toThrow(/--include-component-in-tag must be true or false/);
  });

  // Everything below is measured against a repository that has already
  // released 1.0.0, because the first release comes from the strategy's
  // initial version and would hide what the bump did.
  const released: Partial<FakeRepo> = {
    commits: [{ sha: RELEASED_SHA, message: "chore: release 1.0.0", files: [] }],
    releases: [{ tagName: "v1.0.0", sha: RELEASED_SHA }],
    files: { "package.json": JSON.stringify({ name: "widgets", version: "1.0.0" }) },
  };

  it("bumps the way the default strategy does when nothing says otherwise", async () => {
    await cli(await flags([], released));
    expect(printed()).toContain("**1.1.0**");
  });

  // The gap this closes: a release workflow passing `versioning-strategy`
  // releases a feature as a patch, and a projection with no such input said
  // minor -- the right answer for a differently configured repository.
  it("bumps as the versioning strategy says, not as the type implies", async () => {
    await cli(await flags(["--versioning-strategy", "always-bump-patch"], released));
    expect(printed()).toContain("**1.0.1**");
    expect(printed()).not.toContain("1.1.0");
  });

  it("releases the version a sticky release-as forces", async () => {
    await cli(await flags(["--release-as", "2.4.0"], released));
    expect(printed()).toContain("**2.4.0**");
  });

  // The command line used to build the plain configuration itself and
  // validated none of it, so this reached release-please as a release type it
  // has never heard of. Both entry points read one builder now.
  // Manifest mode, which is what a repository with the two files gets and
  // what `--release-type` switches off. Every other case here passes that
  // flag, so without this the flagless half of the switch -- and the config
  // and manifest flags that only mean anything there -- ran in no test of
  // either entry point.
  describe("without a release type", () => {
    const CONFIG = { packages: { ".": { "release-type": "node" } } };
    const MANIFEST = { ".": "1.0.0" };

    /** checkout writes the two files the way a repository carrying them
     * would, and returns the root to read them from. */
    function checkout(): string {
      const root = tmp();
      writeFileSync(join(root, "release-please-config.json"), JSON.stringify(CONFIG));
      writeFileSync(join(root, ".release-please-manifest.json"), JSON.stringify(MANIFEST));
      return root;
    }

    /** without drops `--release-type` from the ordinary invocation. */
    async function without(extra: string[], over: Partial<FakeRepo> = {}) {
      const argv = await flags(extra, {
        files: {
          "package.json": JSON.stringify({ name: "widgets", version: "1.0.0" }),
          "release-please-config.json": JSON.stringify(CONFIG),
          ".release-please-manifest.json": JSON.stringify(MANIFEST),
        },
        ...over,
      });
      const at = argv.indexOf("--release-type");
      argv.splice(at, 2);
      return argv;
    }

    it("projects from the files in the checkout", async () => {
      await cli(await without(["--repo-root", checkout()]));
      expect(printed()).toContain("**1.1.0**");
    });

    it("says which mode a checkout with no files is missing", async () => {
      await expect(cli(await without(["--repo-root", tmp()]))).rejects.toThrow(
        /no `release-please-config\.json`.*`release-type`/s,
      );
    });
  });

  it("names the release types when the given one is not among them", async () => {
    await expect(
      cli(await flags(["--release-type", "nodejs"])),
    ).rejects.toThrow(/--release-type must be one of .*\bnode\b.*got `nodejs`/s);
  });

  it("names the strategies when the versioning one is not among them", async () => {
    await expect(
      cli(await flags(["--versioning-strategy", "always-bump-path"])),
    ).rejects.toThrow(
      /--versioning-strategy must be one of .*\balways-bump-patch\b.*got `always-bump-path`/s,
    );
  });

  // A version release-please cannot parse otherwise fails from inside the
  // strategy, after the walk, with nothing naming the flag that carried it.
  it("refuses a release-as that is not a version", async () => {
    await expect(
      cli(await flags(["--release-as", "v2.4.0"])),
    ).rejects.toThrow(/--release-as must be a version, like `1\.2\.3`; got `v2\.4\.0`/);
  });

  it("reads a package file the pull request adds, from the head", async () => {
    // Adopting release-please: the pull request adds package.json, so the
    // target branch does not have one and release-please cannot name the
    // component from it. The head's copy is the one that branch will have
    // after the merge, so that is what gets served -- and only for a path the
    // pull request actually changes.
    const root = tmp();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "adopted", version: "0.0.0" }),
    );
    await cli(
      await flags(
        ["--files", "package.json", "--repo-root", root, "--component", "adopted",
         "--include-component-in-tag", "true"],
        // Nothing in the target branch's tree, which is the whole point.
        { files: {} },
      ),
    );
    expect(printed()).toContain("adopted-v1.0.0");
  });

  it("reads the standing release pull requests from a file", async () => {
    // The action queries the API for these; the command line takes the
    // `<branch>\t<url>` lines one `gh pr list` call produces.
    const file = join(tmp(), "prs.tsv");
    writeFileSync(
      file,
      "release-please--branches--master\thttps://github.com/acme/widgets/pull/3\n",
    );
    await cli(await flags(["--release-prs", file]));
    expect(printed()).toContain("| **1.0.0** |");
  });
});
