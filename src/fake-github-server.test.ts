/**
 * The fake's concurrency barrier, which is the only part of it that is a
 * mechanism rather than a canned response.
 *
 * Everything else the fake does is asserted by the suites that drive it: a
 * wrong status or a missing route fails the test that wanted it. The barrier
 * is different, because what it reports is the *absence* of a bug in the code
 * under test. A barrier that latched too easily, or that opened a round early,
 * would report concurrency that never happened -- and the test it reported it
 * to would pass, which is the failure this whole facility exists to prevent
 * one level up.
 *
 * So it is driven here directly, over raw HTTP and without `action()`, and
 * each of its three properties is pinned by re-breaking it: all of them were
 * found by review rather than by a failing test, which is exactly the reason
 * to write the tests.
 */

import { afterEach, describe, expect, it } from "vitest";
import { startFakeGitHub } from "./fake-github-server.fixture.js";
import type { FakeGitHub, FakeRepo } from "./fake-github-server.fixture.js";

/** BARE is a repository with nothing in it: these tests exercise the
 * barrier, and every path below is answered with a 404 as readily as a 200. */
const BARE: FakeRepo = {
  owner: "acme",
  repo: "widgets",
  branch: "master",
  files: {},
  commits: [],
  releases: [],
};

/** A and B are two calls the barrier can be told to hold, named as
 * `requests` records them. */
const A = "GET /repos/acme/widgets";
const B = "GET /repos/acme/widgets/pulls";

let fake: FakeGitHub | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function start(concurrent: readonly string[]): Promise<FakeGitHub> {
  fake = await startFakeGitHub({ ...BARE, concurrent });
  return fake;
}

/** get makes one of those calls and answers how long it was held. */
async function get(server: FakeGitHub, call: string): Promise<number> {
  const started = Date.now();
  await fetch(`${server.url}${call.slice("GET ".length)}`);
  return Date.now() - started;
}

const after = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the fake's concurrency barrier", () => {
  it("reports the overlap two callers in flight together produce", async () => {
    const server = await start([A, B]);
    await Promise.all([get(server, A), get(server, B)]);
    expect(server.overlapped()).toBe(true);
  });

  it("reports none for a caller that waits for each answer", async () => {
    // The false positive that would matter: a serial caller is what the
    // barrier exists to distinguish, and it must not deadlock against one
    // either -- both calls are answered, late, by the barrier's own timer.
    const server = await start([A, B]);
    expect(await get(server, A)).toBeGreaterThan(150);
    expect(await get(server, B)).toBeGreaterThan(150);
    expect(server.overlapped()).toBe(false);
  });

  it("does not let one round's timer open the next", async () => {
    // A round that opens on its last arrival leaves the timers its earlier
    // arrivals armed still running. Firing into a later round, one of those
    // releases a caller that is still waiting for company -- so the round
    // never latches, and a test that should have passed fails with nothing to
    // point at.
    //
    // Round one is completed late on purpose, so the timer its first arrival
    // armed is still running when round two begins.
    const server = await start([A, B]);
    const first = get(server, A);
    await after(200);
    await Promise.all([first, get(server, B)]);

    // Round two now runs inside that armed timer's remaining ~50ms. Its own
    // first call must be held until its own second arrives, 200ms later,
    // rather than released early by round one's leftover.
    const held = get(server, A);
    await after(200);
    await get(server, B);
    expect(await held).toBeGreaterThan(150);
    expect(server.overlapped()).toBe(true);
  });

  it("refuses a barrier one call satisfies by arriving", async () => {
    // One name is met by its own arrival, so `overlapped()` would be true
    // whatever the caller did. A duplicate is the same mistake spelled twice.
    await expect(startFakeGitHub({ ...BARE, concurrent: [A] })).rejects.toThrow(
      /at least two distinct calls/,
    );
    await expect(
      startFakeGitHub({ ...BARE, concurrent: [A, A] }),
    ).rejects.toThrow(/at least two distinct calls/);
  });
});
