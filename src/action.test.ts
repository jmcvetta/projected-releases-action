/**
 * Two things about the action entry point, in that order.
 *
 * First, its manifest and its code are two lists of input names that have to
 * agree, and neither half fails when they do not. An input the code reads but
 * the manifest does not declare is always empty, so the feature it controls
 * silently does nothing. An input the manifest declares but nothing reads is a
 * documented knob with no effect. Both look exactly like working software from
 * the outside, which is why they are checked here rather than left to review.
 *
 * Second, what the entry point does when it runs -- see the second half.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { action } from "./action.js";
import { DEFAULT_HEADER, markerFor } from "./comment.js";
import { startFakeGitHub } from "./fake-github-server.fixture.js";
import type { FakeGitHub, FakeRepo } from "./fake-github-server.fixture.js";

const manifest = parse(
  readFileSync(new URL("../action.yml", import.meta.url), "utf8"),
) as {
  description: string;
  inputs: Record<string, { description: string; default?: string }>;
  outputs: Record<string, { description: string }>;
  runs: { using: string; main: string };
};

// action.ts and plain.ts, which are the only files that name an input:
// plain.ts reads the non-manifest options for both entry points, so an input
// the action offers can be named there rather than here. Scanning runner.ts
// too would pull in the placeholder names from its own tests.
const source = readFileSync(new URL("./action.ts", import.meta.url), "utf8");
const plainSource = readFileSync(new URL("./plain.ts", import.meta.url), "utf8");

/** literalsPassedTo collects the string literals handed to named functions. */
function literalsPassedTo(text: string, callees: string[]): Set<string> {
  const call = new RegExp(`\\b(?:${callees.join("|")})\\(\\s*\\n?\\s*"([^"]+)"`, "g");
  return new Set(
    [...text.matchAll(call)].flatMap((match) => (match[1] ? [match[1]] : [])),
  );
}

const read = new Set([
  ...literalsPassedTo(source, ["input", "inputOr", "boolInput", "listInput"]),
  // plain.ts funnels every option it reads through one local accessor, so
  // that is the callee to scan there.
  ...literalsPassedTo(plainSource, ["value"]),
]);
const declared = new Set(Object.keys(manifest.inputs));

describe("action.yml", () => {
  it("declares every input the action reads", () => {
    // Guards against a scan that quietly matches nothing and so passes both
    // directions vacuously.
    expect(read.size).toBeGreaterThan(10);
    expect([...read].filter((name) => !declared.has(name)).sort()).toEqual([]);
  });

  it("declares no input the action ignores", () => {
    expect([...declared].filter((name) => !read.has(name)).sort()).toEqual([]);
  });

  it("describes every input and output", () => {
    for (const [name, spec] of Object.entries(manifest.inputs)) {
      expect(spec.description, `input ${name}`).toBeTruthy();
    }
    for (const [name, spec] of Object.entries(manifest.outputs)) {
      expect(spec.description, `output ${name}`).toBeTruthy();
    }
  });

  it("declares every output the action sets", () => {
    const set = literalsPassedTo(source, ["setOutput"]);
    expect(set.size).toBeGreaterThan(0);
    expect([...set].filter((name) => !(name in manifest.outputs)).sort()).toEqual([]);
  });

  it("keeps the description short enough for the Marketplace", () => {
    // Publishing rejects a description of 125 characters or more, and the
    // rejection happens at release time rather than in a pull request.
    expect(manifest.description.trim().length).toBeLessThan(125);
  });

  it("points at the committed bundle on a runtime that still exists", () => {
    // Node 20 was removed from Actions runners on 2026-09-16.
    expect(manifest.runs.using).toBe("node24");
    expect(manifest.runs.main).toBe("dist/index.mjs");
  });
});

/**
 * The second half runs the entry point.
 *
 * Everything above is a cross-check between two files. What follows drives
 * `action()` itself against a fake GitHub over real HTTP, because the
 * decisions in action.ts are the ones that fail quietly: a comment write that
 * is forbidden is downgraded to a warning so a fork's pull request keeps a
 * green check, two reads cost a note rather than the run when they fail, and
 * the changed-file list falls back from the checkout to the API. Each of those
 * is an inverted condition away from swallowing a real error or failing on a
 * fork, and neither half of that shows up as a failing test unless it is
 * driven.
 */

/** REPO is a single-package repository with nothing released, so the pull
 * request under test is the whole reason for the release. */
const REPO: FakeRepo = {
  owner: "acme",
  repo: "widgets",
  branch: "master",
  files: {
    "package.json": JSON.stringify({ name: "widgets", version: "0.0.0" }),
  },
  commits: [],
  releases: [],
  prFiles: { 7: ["src/b.ts"] },
};

let fake: FakeGitHub | undefined;
let stdout: string[] = [];

beforeEach(() => {
  stdout = [];
  // Annotations go to the runner as workflow commands on stdout, so they are
  // read here rather than watched for in the test output.
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  // action() points release-please's logger at stderr, which is the right
  // place on a runner and noise here.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fake?.close();
  fake = undefined;
});

/** start runs the fake, overriding the repository it serves. */
async function start(over: Partial<FakeRepo> = {}) {
  fake = await startFakeGitHub({ ...REPO, ...over });
  return fake;
}

/** tmp is a directory for the files a run writes: the rendered body, the
 * runner's output file, and the job summary. */
const tmp = () => mkdtempSync(join(tmpdir(), "projected-releases-"));

/** environment is the ordinary invocation: everything through inputs, the
 * fake for both URLs, the changed files from the API and no release workflow
 * read, so nothing here depends on the checkout this suite happens to run in
 * -- which is this repository, whose own release workflow `auto` would find.
 * The comparison has its own test below, against a checkout written for it. */
function environment(
  server: FakeGitHub,
  over: Record<string, string> = {},
): Record<string, string> {
  const dir = tmp();
  return {
    INPUT_TOKEN: "fake",
    INPUT_REPOSITORY: `${REPO.owner}/${REPO.repo}`,
    INPUT_NUMBER: "7",
    INPUT_TITLE: "feat: a thing",
    INPUT_BASE: REPO.branch,
    "INPUT_HEAD-SHA": "c".repeat(40),
    "INPUT_RELEASE-TYPE": "node",
    "INPUT_API-URL": server.url,
    // The endpoint form, as a runner supplies it. run.ts normalizes it.
    "INPUT_GRAPHQL-URL": `${server.url}/graphql`,
    "INPUT_CHANGED-FILES": "api",
    "INPUT_RELEASE-WORKFLOW": "off",
    "INPUT_OUTPUT-FILE": join(dir, "projected-releases.md"),
    GITHUB_OUTPUT: join(dir, "outputs"),
    GITHUB_STEP_SUMMARY: join(dir, "summary"),
    ...over,
  };
}

/** outputs parses the runner's delimited output file back into a map. */
function outputs(env: Record<string, string>): Record<string, string> {
  const text = existsSync(env["GITHUB_OUTPUT"]!)
    ? readFileSync(env["GITHUB_OUTPUT"]!, "utf8")
    : "";
  const found: Record<string, string> = {};
  const pattern = /^(\S+)<<(ghadelimiter_\S+)\n([\s\S]*?)\n\2\n/gm;
  for (const match of text.matchAll(pattern)) found[match[1]!] = match[3]!;
  return found;
}

const annotations = () => stdout.join("");

describe("action", () => {
  it("renders, writes the outputs, and posts the comment", async () => {
    const server = await start();
    const env = environment(server);
    await action(env);

    const body = readFileSync(env["INPUT_OUTPUT-FILE"]!, "utf8");
    expect(body).toContain("| **1.0.0** |");
    expect(body).toContain("Changelog preview");

    const out = outputs(env);
    expect(out["body"]).toBe(body);
    expect(out["comment-file"]).toBe(env["INPUT_OUTPUT-FILE"]);
    expect(out["releases-count"]).toBe("1");
    expect(out["malformed-title"]).toBe("false");
    expect(JSON.parse(out["releases"] ?? "[]")).toHaveLength(1);
    // Resolved from the preset, since this repository declares no sections.
    expect(out["recognized-types"]?.split(",")).toContain("feat");

    // The comment is the rendered body, under its own hidden marker.
    expect(server.comments).toHaveLength(1);
    expect(server.comments[0]?.body).toContain(markerFor(DEFAULT_HEADER));
    expect(server.comments[0]?.body).toContain("| **1.0.0** |");
    expect(annotations()).toContain("::notice::projected-releases comment created");

    // And the job summary, which is where a fork's projection has to live.
    expect(readFileSync(env["GITHUB_STEP_SUMMARY"]!, "utf8")).toContain(
      "| **1.0.0** |",
    );
  });

  it("edits its own comment in place rather than adding a second", async () => {
    const server = await start();
    await action(environment(server));
    await action(environment(server, { INPUT_TITLE: "feat: a second thing" }));
    expect(server.comments).toHaveLength(1);
    expect(server.comments[0]?.body).toContain("a second thing");
    expect(annotations()).toContain("::notice::projected-releases comment updated");
  });

  it("defaults its context from the webhook payload", async () => {
    const server = await start();
    const file = join(tmp(), "event.json");
    writeFileSync(
      file,
      JSON.stringify({
        pull_request: {
          number: 7,
          title: "feat: from the payload",
          body: "",
          base: { ref: REPO.branch },
          head: { sha: "d".repeat(40), ref: "topic" },
        },
      }),
    );
    const env = environment(server, { GITHUB_EVENT_PATH: file });
    for (const name of ["INPUT_NUMBER", "INPUT_TITLE", "INPUT_BASE", "INPUT_HEAD-SHA"]) {
      delete env[name];
    }
    await action(env);
    const body = readFileSync(env["INPUT_OUTPUT-FILE"]!, "utf8");
    expect(body).toContain("from the payload");
    expect(body).toContain("Projected for `ddddddd`");
  });

  it("links the footer at the run the runner is in", async () => {
    const server = await start();
    const env = environment(server, {
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: `${REPO.owner}/${REPO.repo}`,
      GITHUB_RUN_ID: "99",
    });
    await action(env);
    expect(readFileSync(env["INPUT_OUTPUT-FILE"]!, "utf8")).toContain(
      "https://github.com/acme/widgets/actions/runs/99",
    );
  });
});

describe("action modes", () => {
  it("renders without posting in `render`", async () => {
    const server = await start();
    const env = environment(server, { INPUT_MODE: "render" });
    await action(env);
    expect(readFileSync(env["INPUT_OUTPUT-FILE"]!, "utf8")).toContain("1.0.0");
    expect(server.comments).toEqual([]);
  });

  it("posts a body an earlier job rendered in `comment`, and renders nothing", async () => {
    // The fork-safe arrangement: a read-only token renders, a write token
    // posts. Nothing here should reach release-please at all.
    const server = await start();
    const env = environment(server, { INPUT_MODE: "comment" });
    writeFileSync(env["INPUT_OUTPUT-FILE"]!, "rendered earlier");
    await action(env);
    expect(server.comments[0]?.body).toContain("rendered earlier");
    expect(server.requests.some((r) => r.includes("graphql"))).toBe(false);
    expect(outputs(env)).toEqual({ "comment-file": env["INPUT_OUTPUT-FILE"] });
  });

  it("refuses a mode it does not have", async () => {
    await expect(action({ INPUT_MODE: "post" })).rejects.toThrow(
      /must be one of render-and-comment, render, comment/,
    );
  });
});

describe("action, when the comment cannot be posted", () => {
  // A pull request from a fork carries a read-only token. Failing the run
  // there would put a red check on every outside contribution over an
  // advisory comment, so the projection is left in the job summary instead.
  for (const status of [403, 404]) {
    it(`warns rather than failing on ${status}`, async () => {
      const server = await start({ commentStatus: status });
      const env = environment(server);
      await action(env);
      expect(annotations()).toContain("::warning::could not post");
      // The projection was still produced, which is the point of not failing.
      expect(readFileSync(env["INPUT_OUTPUT-FILE"]!, "utf8")).toContain("1.0.0");
    });
  }

  it("fails on a status that is not about permission", async () => {
    const server = await start({ commentStatus: 500 });
    await expect(action(environment(server))).rejects.toThrow(/500/);
  });
});

describe("action, when a read it can do without fails", () => {
  it("costs the merge advisory and not the comment", async () => {
    const server = await start({ repositoryStatus: 500 });
    const env = environment(server);
    await action(env);
    expect(annotations()).toContain("could not read the repository's merge settings");
    expect(readFileSync(env["INPUT_OUTPUT-FILE"]!, "utf8")).toContain("1.0.0");
  });

  it("costs the release pull request links and not the comment", async () => {
    const server = await start({ pullsStatus: 500 });
    const env = environment(server);
    await action(env);
    expect(annotations()).toContain("could not list the open release pull requests");
    expect(readFileSync(env["INPUT_OUTPUT-FILE"]!, "utf8")).toContain("1.0.0");
  });

  it("does not list the pull requests at all when the links are off", async () => {
    const server = await start();
    await action(environment(server, { "INPUT_LINK-RELEASE-PRS": "false" }));
    expect(server.requests).not.toContain("GET /repos/acme/widgets/pulls");
  });

  it("warns when it cannot read the commits a merge would write", async () => {
    // With no checkout to read and nothing for the API to list, the
    // projection falls back to the squash answer -- and says so, because a
    // projection that describes a merge this repository will not perform is
    // worse than no projection.
    const server = await start();
    const env = environment(server, { "INPUT_MERGE-METHOD": "merge" });
    await action(env);
    expect(annotations()).toContain(
      "::warning::This repository is configured as `merge-method: merge`",
    );
    expect(readFileSync(env["INPUT_OUTPUT-FILE"]!, "utf8")).toContain(
      "does not describe this merge",
    );
  });

  it("projects a rebase from the branch's commits, read through the API", async () => {
    // The title is a `feat:` and would release 1.0.0 under a squash-merge.
    // Under a rebase it is not an input at all: the branch's one `fix:` is,
    // and the version that comes out is release-please's answer to that.
    const server = await start({
      prCommits: {
        7: [{ sha: "a".repeat(40), message: "fix: a crash", files: ["src/b.ts"] }],
      },
    });
    const env = environment(server, {
      "INPUT_MERGE-METHOD": "rebase",
      // A title a squash-merging repository's gate would reject outright.
      INPUT_TITLE: "not a conventional commit at all",
    });
    await action(env);

    const body = readFileSync(env["INPUT_OUTPUT-FILE"]!, "utf8");
    expect(body).toContain("models the branch's own commits");
    expect(body).not.toContain("malformed PR title");
    expect(outputs(env)["malformed-title"]).toBe("false");
    expect(server.requests).toContain("GET /repos/acme/widgets/pulls/7/commits");
    expect(server.requests).toContain(`GET /repos/acme/widgets/commits/${"a".repeat(40)}`);
    expect(annotations()).toContain("read the branch's 1 commit from the API");
  });

  it("projects a merge commit from the branch's commits and the title", async () => {
    // GitHub's default merge commit carries the pull request title in its
    // body, so a merge-commit repository releases from the title as well as
    // from the branch. The `feat:` title is what makes this a minor release
    // rather than the patch the branch alone would cut.
    const server = await start({
      prCommits: {
        7: [{ sha: "b".repeat(40), message: "fix: a crash", files: ["src/b.ts"] }],
      },
    });
    const env = environment(server, { "INPUT_MERGE-METHOD": "merge" });
    await action(env);

    const body = readFileSync(env["INPUT_OUTPUT-FILE"]!, "utf8");
    expect(body).toContain(", plus a merge commit above them");
    expect(body).not.toContain("does not describe this merge");
    expect(body).toContain("a crash");
    expect(body).toContain("a thing");
  });

  it("reads the branch's commits only for a merge it is modelling", async () => {
    const server = await start({
      prCommits: {
        7: [{ sha: "c".repeat(40), message: "fix: a crash", files: ["src/b.ts"] }],
      },
    });
    await action(environment(server));
    expect(server.requests).not.toContain("GET /repos/acme/widgets/pulls/7/commits");
  });

  it("models the method a repository that cannot squash does allow", async () => {
    const server = await start({
      merge: { allow_squash_merge: false, allow_merge_commit: true },
      prCommits: {
        7: [{ sha: "d".repeat(40), message: "fix: a crash", files: ["src/b.ts"] }],
      },
    });
    const env = environment(server, { "INPUT_MERGE-METHOD": "auto" });
    await action(env);
    expect(readFileSync(env["INPUT_OUTPUT-FILE"]!, "utf8")).toContain(
      "does not allow squash-merge",
    );
  });

  it("takes squash and rebase at their word, without reading the settings", async () => {
    const server = await start();
    await action(environment(server, { "INPUT_MERGE-METHOD": "rebase" }));
    expect(server.requests).not.toContain("GET /repos/acme/widgets");
  });

  it("reads the merge commit's own format even for a declared merge", async () => {
    // The settings decide whether the merge commit carries the title, which
    // decides whether the title releases. `BLANK` here, so the `feat:` title
    // is not an input and the branch's `fix:` is the whole answer.
    const server = await start({
      merge: { merge_commit_message: "BLANK" },
      prCommits: {
        7: [{ sha: "e".repeat(40), message: "fix: a crash", files: ["src/b.ts"] }],
      },
    });
    const env = environment(server, { "INPUT_MERGE-METHOD": "merge" });
    await action(env);
    expect(server.requests).toContain("GET /repos/acme/widgets");
    const body = readFileSync(env["INPUT_OUTPUT-FILE"]!, "utf8");
    expect(body).toContain("a crash");
    expect(body).not.toContain("a thing");
  });

  it("compares its inputs with the release workflow, in the comment and the log", async () => {
    // The drift this exists for: the release workflow bumps every release as
    // a patch and the projection was not told, so it reports the minor a
    // default repository would get. Through the comment and the run's
    // annotations both, since a note only one of them carries is one half the
    // readers will miss.
    const root = tmp();
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(root, ".github", "workflows", "release.yml"),
      "jobs:\n  release:\n    steps:\n" +
        "      - uses: googleapis/release-please-action@v5\n" +
        "        with:\n          release-type: node\n" +
        "          versioning-strategy: always-bump-patch\n",
    );
    const server = await start();
    const env = environment(server, {
      "INPUT_REPO-ROOT": root,
      "INPUT_RELEASE-WORKFLOW": "auto",
    });
    await action(env);

    const body = readFileSync(env["INPUT_OUTPUT-FILE"]!, "utf8");
    expect(body).toContain("`versioning-strategy: always-bump-patch`");
    expect(annotations()).toContain("::warning::`.github/workflows/release.yml`");
  });

  it("refuses a merge method that is not one", async () => {
    const server = await start();
    await expect(
      action(environment(server, { "INPUT_MERGE-METHOD": "fast-forward" })),
    ).rejects.toThrow(/must be one of/);
  });
});

describe("action's changed-file list", () => {
  it("reads the checkout when it can", async () => {
    // `HEAD` against itself is an empty diff, which every checkout can
    // answer -- including the shallow one this suite might be running in.
    const server = await start();
    await action(
      environment(server, {
        "INPUT_CHANGED-FILES": "git",
        "INPUT_DIFF-BASE": "HEAD",
        INPUT_HEAD: "HEAD",
      }),
    );
    expect(server.requests).not.toContain("GET /repos/acme/widgets/pulls/7/files");
  });

  it("falls back to the API when the checkout has no merge base", async () => {
    // actions/checkout is shallow by default, so this is the ordinary case
    // rather than the exceptional one. git prints its own `fatal:` line to
    // stderr on the way past, here and on a runner both; it is the failure
    // being handled, not one.
    const server = await start();
    const env = environment(server, {
      "INPUT_CHANGED-FILES": "auto",
      "INPUT_DIFF-BASE": "origin/no-such-branch-here",
    });
    await action(env);
    expect(annotations()).toContain("the checkout has no usable merge base");
    expect(server.requests).toContain("GET /repos/acme/widgets/pulls/7/files");
  });

  it("does not fall back when the caller asked for the checkout by name", async () => {
    const server = await start();
    await expect(
      action(
        environment(server, {
          "INPUT_CHANGED-FILES": "git",
          "INPUT_DIFF-BASE": "origin/no-such-branch-here",
        }),
      ),
    ).rejects.toThrow();
  });

  it("refuses a source it does not have", async () => {
    const server = await start();
    await expect(
      action(environment(server, { "INPUT_CHANGED-FILES": "guess" })),
    ).rejects.toThrow(/must be one of auto, git, api/);
  });
});

describe("action's release configuration", () => {
  it("names the valid types when `release-type` is not one", async () => {
    const server = await start();
    await expect(
      action(environment(server, { "INPUT_RELEASE-TYPE": "nodejs" })),
    ).rejects.toThrow(/must be one of .*\bnode\b.*got `nodejs`/s);
  });

  // The same builder the command line uses, so this is really about the half
  // that differs: that the action names an input the way an input is named.
  it("names the offending input when a plain-mode value is not valid", async () => {
    const server = await start();
    await expect(
      action(environment(server, { "INPUT_VERSIONING-STRATEGY": "always-bump-path" })),
    ).rejects.toThrow(/input `versioning-strategy` must be one of .*got `always-bump-path`/s);
    await expect(
      action(environment(server, { "INPUT_RELEASE-AS": "v2.4.0" })),
    ).rejects.toThrow(/input `release-as` must be a version/);
  });

  it("carries the plain-mode package options through to the tag", async () => {
    const server = await start();
    const env = environment(server, {
      INPUT_COMPONENT: "acme-api",
      "INPUT_INCLUDE-COMPONENT-IN-TAG": "true",
      "INPUT_TAG-SEPARATOR": "@",
    });
    await action(env);
    expect(readFileSync(env["INPUT_OUTPUT-FILE"]!, "utf8")).toContain("acme-api@v1.0.0");
  });

  it("takes the changelog types from the inputs when they are given", async () => {
    const server = await start();
    const env = environment(server, {
      "INPUT_VISIBLE-TYPES": "ship, tidy",
      "INPUT_HIDDEN-TYPES": "chore",
      INPUT_TITLE: "feat: a thing",
    });
    await action(env);
    // `feat` is not among the declared types, so this title cannot become a
    // commit this repository recognizes.
    const body = readFileSync(env["INPUT_OUTPUT-FILE"]!, "utf8");
    expect(body).toContain("malformed PR title");
    expect(body).toContain("`ship`");
    expect(outputs(env)["malformed-title"]).toBe("true");
    expect(outputs(env)["recognized-types"]).toBe("chore,ship,tidy");
  });

  it("leaves the job summary alone when asked to", async () => {
    const server = await start();
    const env = environment(server, { "INPUT_STEP-SUMMARY": "false" });
    await action(env);
    expect(existsSync(env["GITHUB_STEP_SUMMARY"]!)).toBe(false);
  });
});

describe("action's required context", () => {
  it("says which one is missing rather than failing deeper in", async () => {
    await expect(action({})).rejects.toThrow(/determine the repository/);
    await expect(
      action({ GITHUB_REPOSITORY: "acme/widgets" }),
    ).rejects.toThrow(/determine the pull request number/);
    await expect(
      action({ GITHUB_REPOSITORY: "acme/widgets", INPUT_NUMBER: "7" }),
    ).rejects.toThrow(/`token` is required/);
    await expect(
      action({
        GITHUB_REPOSITORY: "acme/widgets",
        INPUT_NUMBER: "7",
        INPUT_TOKEN: "t",
      }),
    ).rejects.toThrow(/determine the title/);
    await expect(
      action({
        GITHUB_REPOSITORY: "acme/widgets",
        INPUT_NUMBER: "7",
        INPUT_TOKEN: "t",
        INPUT_TITLE: "feat: a thing",
      }),
    ).rejects.toThrow(/determine the base branch/);
  });

  it("takes the repository from the runner when no input names one", async () => {
    // GITHUB_REPOSITORY is set on every runner; the `repository` input exists
    // for the workflow_run arrangement, where the payload is about another
    // workflow. Getting past the repository check to the next one is what
    // says the runner's value was read.
    await expect(
      action({ GITHUB_REPOSITORY: "acme/widgets" }),
    ).rejects.toThrow(/determine the pull request number/);
    // And a value that is not owner/name is refused rather than split into
    // an empty owner and a repository that does not exist.
    await expect(action({ GITHUB_REPOSITORY: "widgets" })).rejects.toThrow(
      /determine the repository/,
    );
  });
});
