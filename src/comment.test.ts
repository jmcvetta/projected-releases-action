import { describe, expect, it } from "vitest";
import type { Client, IssueComment } from "./api.js";
import { findSticky, markerFor, stick, withMarker } from "./comment.js";

/** fakeClient records what a stick() does, without an API. */
function fakeClient(existing: IssueComment[]): {
  client: Client;
  created: string[];
  updated: { id: number; body: string }[];
  reads: () => number;
} {
  const created: string[] = [];
  const updated: { id: number; body: string }[] = [];
  let reads = 0;
  const client = {
    async issueComments() {
      reads++;
      return existing;
    },
    async createComment(_number: number, body: string) {
      created.push(body);
      return { id: 99, body };
    },
    async updateComment(id: number, body: string) {
      updated.push({ id, body });
      return { id, body };
    },
  } as unknown as Client;
  return { client, created, updated, reads: () => reads };
}

describe("withMarker", () => {
  it("prefixes the hidden marker", () => {
    expect(withMarker("h", "body")).toBe(`${markerFor("h")}\nbody`);
  });

  it("does not prefix twice", () => {
    const once = withMarker("h", "body");
    expect(withMarker("h", once)).toBe(once);
  });
});

describe("findSticky", () => {
  it("matches on the marker, not on authorship or recency", () => {
    // The point of the marker: a repository whose CI leaves its own comment
    // under the same bot identity would collide with "my newest comment".
    const comments = [
      { id: 1, body: "coverage went up" },
      { id: 2, body: `${markerFor("projected-releases")}\nold projection` },
      { id: 3, body: "someone's review" },
    ];
    expect(findSticky(comments, "projected-releases")?.id).toBe(2);
  });

  it("does not match a different header's comment", () => {
    const comments = [{ id: 1, body: `${markerFor("other")}\nx` }];
    expect(findSticky(comments, "projected-releases")).toBeUndefined();
  });
});

describe("stick", () => {
  it("creates the comment when there is none", async () => {
    const { client, created, updated } = fakeClient([]);
    expect(await stick(client, 7, "h", "hello")).toEqual({
      action: "created",
      id: 99,
    });
    expect(created).toEqual([withMarker("h", "hello")]);
    expect(updated).toEqual([]);
  });

  it("edits the existing comment in place", async () => {
    const { client, created, updated } = fakeClient([
      { id: 4, body: withMarker("h", "old") },
    ]);
    expect(await stick(client, 7, "h", "new")).toEqual({
      action: "updated",
      id: 4,
    });
    expect(created).toEqual([]);
    expect(updated).toEqual([{ id: 4, body: withMarker("h", "new") }]);
  });

  it("takes the list from a caller that already read it", async () => {
    // The caller starts that read before rendering, which takes seconds, so
    // the post costs one write rather than a read and a write.
    const { client, updated, reads } = fakeClient([]);
    const listed = Promise.resolve([{ id: 4, body: withMarker("h", "old") }]);
    expect(await stick(client, 7, "h", "new", listed)).toEqual({
      action: "updated",
      id: 4,
    });
    expect(updated).toEqual([{ id: 4, body: withMarker("h", "new") }]);
    expect(reads()).toBe(0);
  });

  it("confirms an absence in that list before adding a second comment", async () => {
    // The comment another run posted in the seconds since the handed-over
    // list was read. Trusting the absence would create a second sticky
    // comment, and `findSticky` would serve the first of the two from then
    // on, leaving this one showing a stale projection forever.
    const { client, created, updated, reads } = fakeClient([
      { id: 4, body: withMarker("h", "posted since") },
    ]);
    expect(await stick(client, 7, "h", "new", Promise.resolve([]))).toEqual({
      action: "updated",
      id: 4,
    });
    expect(created).toEqual([]);
    expect(updated).toEqual([{ id: 4, body: withMarker("h", "new") }]);
    expect(reads()).toBe(1);
  });

  it("creates once the fresh read agrees there is nothing", async () => {
    const { client, created, reads } = fakeClient([]);
    expect(await stick(client, 7, "h", "new", Promise.resolve([]))).toEqual({
      action: "created",
      id: 99,
    });
    expect(created).toEqual([withMarker("h", "new")]);
    expect(reads()).toBe(1);
  });

  it("reads for itself when that caller's read gave nothing", async () => {
    // A head start that failed is handed over as `undefined`, so the failure
    // surfaces here, from the read that would have happened anyway.
    const { client, updated, reads } = fakeClient([
      { id: 4, body: withMarker("h", "old") },
    ]);
    expect(await stick(client, 7, "h", "new", Promise.resolve(undefined))).toEqual({
      action: "updated",
      id: 4,
    });
    expect(updated).toEqual([{ id: 4, body: withMarker("h", "new") }]);
    expect(reads()).toBe(1);
  });

  it("writes nothing when the body is unchanged", async () => {
    const { client, created, updated } = fakeClient([
      { id: 4, body: withMarker("h", "same") },
    ]);
    expect(await stick(client, 7, "h", "same")).toEqual({
      action: "unchanged",
      id: 4,
    });
    expect(created).toEqual([]);
    expect(updated).toEqual([]);
  });
});
