/**
 * Runs the committed bundle, as a process, against a fake GitHub over real
 * HTTP, and asserts the markdown it prints.
 *
 * Everything else in this suite substitutes a `GitHub` object, which skips the
 * whole span between an option and an HTTP request: URL assembly, the Octokit
 * clients, the changelog preset's own file reads, and the bundling that turns
 * all of it into one artifact. Two bugs lived in exactly that span, and the
 * suite was green through both:
 *
 *   - the GraphQL endpoint was assembled as `.../graphql/graphql`, because a
 *     runner's GITHUB_GRAPHQL_URL is the endpoint and release-please wants the
 *     API root;
 *   - the changelog preset reads four Handlebars templates from
 *     `__dirname/templates/`, which an ESM bundle has neither of.
 *
 * Both were found by running the action on its own pull request. This is that
 * run, made cheap and offline enough to keep.
 */

import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { startFakeGitHub } from "./fake-github-server.fixture.js";
import type { FakeGitHub } from "./fake-github-server.fixture.js";

const run = promisify(execFile);
const BUNDLE = new URL("../dist/index.mjs", import.meta.url).pathname;

/** empty is a directory holding neither of release-please's files, which is
 * what plain mode is for. See `--repo-root` below. */
const empty = () => mkdtempSync(join(tmpdir(), "projected-releases-"));

/**
 * REPO is a single-package repository with nothing released and nothing
 * pending, so the pull request under test is the whole reason for the
 * release. That keeps the table moving and the changelog rendered, which is
 * the part this test exists for: version arithmetic is already measured
 * against a real Manifest in project.test.ts, and re-measuring it here would
 * only test the fidelity of the fake.
 */
const REPO = {
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
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

/** project runs the bundle against the fake and returns the rendered
 * markdown. Failures carry the bundle's stderr, which is where a bundling
 * error surfaces. */
async function project(title: string, extra: string[] = []): Promise<string> {
  fake = await startFakeGitHub(REPO);
  const { stdout } = await run(
    process.execPath,
    [
      BUNDLE,
      "--title", title,
      "--repo", `${REPO.owner}/${REPO.repo}`,
      "--base", REPO.branch,
      "--release-type", "node",
      "--api-url", fake.url,
      // The endpoint form, deliberately: this is what a runner's
      // GITHUB_GRAPHQL_URL and `${{ github.graphql_url }}` both hold, and it
      // is the value that produced `/graphql/graphql`. Passing the root here
      // would make the normalization a no-op and the test vacuous -- checked,
      // by reintroducing the bug against both forms.
      "--graphql-url", `${fake.url}/graphql`,
      "--number", "7",
      "--head-sha", "c".repeat(40),
      "--files", "src/b.ts",
      // This runs in this repository's own checkout, and the input
      // comparison would find this repository's own release workflow. What
      // that workflow says is not what this test is measuring, and a change
      // to it does not even run this suite -- test.yml's `paths:` list does
      // not name .github/workflows.
      "--release-workflow", "off",
      // And read no config files, for the same reason: this repository has a
      // release-please-config.json of its own, and plain mode with those
      // files in the checkout is a note on the comment about a repository
      // this test is not describing.
      "--repo-root", empty(),
      ...extra,
    ],
    { env: { ...process.env, GITHUB_TOKEN: "fake" } },
  );
  return stdout;
}

describe("the committed bundle, run against a fake GitHub", () => {
  it("renders a projection, changelog and all", async () => {
    const out = await project("feat: a thing");
    // The version comes from release-please, through the bundle. Its tag is
    // `v` and the version, so the column that would repeat it is dropped.
    expect(out).toContain("| **1.0.0** |");
    // And the changelog, which is the part that needs the Handlebars
    // templates to have shipped beside the bundle.
    expect(out).toContain("Changelog preview");
    expect(out).toContain("a thing");
  });

  it("keeps release-please's logging off stdout", async () => {
    // The boundary warning is read out of release-please's log stream, which
    // means the action installs a logger over release-please's own and needs
    // that to still be the same module once esbuild has inlined both. If it
    // were not, the default logger would survive and print to stdout -- where
    // the CLI writes the comment body -- so a clean first line is the
    // observable form of the seam holding.
    const out = await project("feat: a thing");
    expect(out.startsWith("## Projected releases")).toBe(true);
    expect(out).not.toContain("Splitting ");
  });

  it("reports that a type that releases nothing releases nothing", async () => {
    expect(await project("chore: tidy up")).toContain(
      "None — `chore:` produces no release.",
    );
  });

  it("asks for GraphQL at /graphql and nowhere else", async () => {
    // The direct regression test for the endpoint bug: release-please is
    // handed an API root and Octokit appends `/graphql`. Passing the endpoint
    // through unchanged produced `/graphql/graphql`, a 404, and a bare
    // `HttpError: Not Found` with nothing in it naming the cause.
    await project("feat: a thing");
    const graphql = fake!.requests.filter((r) => r.includes("graphql"));
    expect(graphql.length).toBeGreaterThan(0);
    expect([...new Set(graphql)]).toEqual(["POST /graphql"]);
  });
});
